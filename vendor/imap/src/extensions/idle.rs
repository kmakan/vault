//! Adds support for the IMAP IDLE command specificed in [RFC
//! 2177](https://tools.ietf.org/html/rfc2177).

use crate::client::Session;
use crate::error::{Error, Result};
#[cfg(feature = "tls")]
use native_tls::TlsStream;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// `Handle` allows a client to block waiting for changes to the remote mailbox.
///
/// The handle blocks using the [`IDLE` command](https://tools.ietf.org/html/rfc2177#section-3)
/// specificed in [RFC 2177](https://tools.ietf.org/html/rfc2177) until the underlying server state
/// changes in some way. While idling does inform the client what changes happened on the server,
/// this implementation will currently just block until _anything_ changes, and then notify the
///
/// Note that the server MAY consider a client inactive if it has an IDLE command running, and if
/// such a server has an inactivity timeout it MAY log the client off implicitly at the end of its
/// timeout period.  Because of that, clients using IDLE are advised to terminate the IDLE and
/// re-issue it at least every 29 minutes to avoid being logged off. [`Handle::wait_keepalive`]
/// does this. This still allows a client to receive immediate mailbox updates even though it need
/// only "poll" at half hour intervals.
///
/// As long as a [`Handle`] is active, the mailbox cannot be otherwise accessed.
#[derive(Debug)]
pub struct Handle<'a, T: Read + Write> {
    session: &'a mut Session<T>,
    keepalive: Duration,
    done: bool,
}

/// The result of a wait on a [`Handle`]
#[derive(Debug, PartialEq, Eq)]
pub enum WaitOutcome {
    /// The wait timed out
    TimedOut,
    /// The mailbox was modified
    MailboxChanged,
}

/// Must be implemented for a transport in order for a `Session` using that transport to support
/// operations with timeouts.
///
/// Examples of where this is useful is for `Handle::wait_keepalive` and
/// `Handle::wait_timeout`.
pub trait SetReadTimeout {
    /// Set the timeout for subsequent reads to the given one.
    ///
    /// If `timeout` is `None`, the read timeout should be removed.
    ///
    /// See also `std::net::TcpStream::set_read_timeout`.
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()>;

    /// Get the timeout currently in effect for subsequent reads.
    ///
    /// Returns `None` if reads currently have no timeout (i.e. they block
    /// indefinitely). This is used to remember a transport's configured
    /// timeout before an IDLE wait temporarily overrides it, so that the
    /// original value can be restored afterwards.
    ///
    /// The default implementation returns `Ok(None)`, which preserves the
    /// previous no-timeout semantics for custom transports that only
    /// implement [`set_read_timeout`](Self::set_read_timeout). Transports
    /// that want their configured timeout to survive an IDLE wait **must**
    /// override this getter to report the real current timeout.
    ///
    /// See also `std::net::TcpStream::read_timeout`.
    fn read_timeout(&self) -> Result<Option<Duration>> {
        Ok(None)
    }
}

impl<'a, T: Read + Write + 'a> Handle<'a, T> {
    pub(crate) fn make(session: &'a mut Session<T>) -> Result<Self> {
        let mut h = Handle {
            session,
            keepalive: Duration::from_secs(29 * 60),
            done: false,
        };
        h.init()?;
        Ok(h)
    }

    fn init(&mut self) -> Result<()> {
        // https://tools.ietf.org/html/rfc2177
        //
        // The IDLE command takes no arguments.
        self.session.run_command("IDLE")?;

        // A tagged response will be sent either
        //
        //   a) if there's an error, or
        //   b) *after* we send DONE
        let mut v = Vec::new();
        self.session.readline(&mut v)?;
        if v.starts_with(b"+") {
            self.done = false;
            return Ok(());
        }

        self.session.read_response_onto(&mut v)?;
        // We should *only* get a continuation on an error (i.e., it gives BAD or NO).
        unreachable!();
    }

    fn terminate(&mut self) -> Result<()> {
        if !self.done {
            self.done = true;
            self.session.write_line(b"DONE")?;
            self.session.read_response().map(|_| ())
        } else {
            Ok(())
        }
    }

    /// Internal helper that doesn't consume self.
    ///
    /// This is necessary so that we can keep using the inner `Session` in `wait_keepalive`.
    fn wait_inner(&mut self, reconnect: bool) -> Result<WaitOutcome> {
        let mut v = Vec::new();
        loop {
            let result = match self.session.readline(&mut v).map(|_| ()) {
                Err(Error::Io(ref e))
                    if e.kind() == io::ErrorKind::TimedOut
                        || e.kind() == io::ErrorKind::WouldBlock =>
                {
                    if reconnect {
                        self.terminate()?;
                        self.init()?;
                        return self.wait_inner(reconnect);
                    }
                    Ok(WaitOutcome::TimedOut)
                }
                Ok(()) => Ok(WaitOutcome::MailboxChanged),
                Err(r) => Err(r),
            }?;

            // Handle Dovecot's imap_idle_notify_interval message
            if v.eq_ignore_ascii_case(b"* OK Still here\r\n") {
                v.clear();
            } else {
                break Ok(result);
            }
        }
    }

    /// Block until the selected mailbox changes.
    pub fn wait(mut self) -> Result<()> {
        self.wait_inner(true).map(|_| ())
    }
}

impl<'a, T: SetReadTimeout + Read + Write + 'a> Handle<'a, T> {
    /// Set the keep-alive interval to use when `wait_keepalive` is called.
    ///
    /// The interval defaults to 29 minutes as dictated by RFC 2177.
    pub fn set_keepalive(&mut self, interval: Duration) {
        self.keepalive = interval;
    }

    /// Block until the selected mailbox changes.
    ///
    /// This method differs from [`Handle::wait`] in that it will periodically refresh the IDLE
    /// connection, to prevent the server from timing out our connection. The keepalive interval is
    /// set to 29 minutes by default, as dictated by RFC 2177, but can be changed using
    /// [`Handle::set_keepalive`].
    ///
    /// This is the recommended method to use for waiting.
    pub fn wait_keepalive(self) -> Result<()> {
        // The server MAY consider a client inactive if it has an IDLE command
        // running, and if such a server has an inactivity timeout it MAY log
        // the client off implicitly at the end of its timeout period.  Because
        // of that, clients using IDLE are advised to terminate the IDLE and
        // re-issue it at least every 29 minutes to avoid being logged off.
        // This still allows a client to receive immediate mailbox updates even
        // though it need only "poll" at half hour intervals.
        let keepalive = self.keepalive;
        self.timed_wait(keepalive, true).map(|_| ())
    }

    /// Block until the selected mailbox changes, or until the given amount of time has expired.
    #[deprecated(note = "use wait_with_timeout instead")]
    pub fn wait_timeout(self, timeout: Duration) -> Result<()> {
        self.wait_with_timeout(timeout).map(|_| ())
    }

    /// Block until the selected mailbox changes, or until the given amount of time has expired.
    pub fn wait_with_timeout(self, timeout: Duration) -> Result<WaitOutcome> {
        self.timed_wait(timeout, false)
    }

    fn timed_wait(mut self, timeout: Duration, reconnect: bool) -> Result<WaitOutcome> {
        // Remember the transport's currently configured read timeout before we
        // temporarily override it, so we can restore it afterwards. Restoring
        // (rather than unconditionally clearing) is what keeps the caller's
        // configured timeout in effect for the DONE/terminate read below (which
        // runs when this `Handle` is dropped) and for any subsequent commands.
        let previous = self.session.stream.get_ref().read_timeout()?;
        self.session
            .stream
            .get_mut()
            .set_read_timeout(Some(timeout))?;
        let res = self.wait_inner(reconnect);
        // Restore the previous read timeout before returning (and thus before
        // the `Drop` impl runs `terminate`, which writes DONE and reads a tagged
        // response). This must happen on both the success and the error path so
        // the socket is never left without its configured timeout.
        if let Err(e) = self.session.stream.get_mut().set_read_timeout(previous) {
            // Surface the restore failure instead of silently ignoring it, but
            // prefer not to mask the original wait outcome when the wait already
            // errored.
            if res.is_ok() {
                return Err(e);
            }
        }
        res
    }
}

impl<'a, T: Read + Write + 'a> Drop for Handle<'a, T> {
    fn drop(&mut self) {
        // we don't want to panic here if we can't terminate the Idle
        let _ = self.terminate().is_ok();
    }
}

impl<'a> SetReadTimeout for TcpStream {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()> {
        TcpStream::set_read_timeout(self, timeout).map_err(Error::Io)
    }

    fn read_timeout(&self) -> Result<Option<Duration>> {
        TcpStream::read_timeout(self).map_err(Error::Io)
    }
}

#[cfg(feature = "tls")]
impl<'a> SetReadTimeout for TlsStream<TcpStream> {
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()> {
        self.get_ref().set_read_timeout(timeout).map_err(Error::Io)
    }

    fn read_timeout(&self) -> Result<Option<Duration>> {
        self.get_ref().read_timeout().map_err(Error::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Client;
    use std::io::ErrorKind;

    const THIRTY: Duration = Duration::from_secs(30);
    const FIVE: Duration = Duration::from_secs(5);
    const SEVEN: Duration = Duration::from_secs(7);

    /// A transport that records the *real* read timeout it is configured with,
    /// the full history of values passed to `set_read_timeout`, and the timeout
    /// that was in effect when the DONE response (following a `DONE` write) was
    /// read. This exercises the live IDLE algorithm end-to-end rather than
    /// re-implementing it.
    ///
    /// Data is handed out one byte per `read` call so that `BufStream` cannot
    /// read ahead across command boundaries: this guarantees that the read of
    /// the DONE response actually goes through this transport (and observes its
    /// current timeout) instead of being served from `BufStream`'s buffer.
    #[derive(Debug)]
    struct FakeStream {
        read_buf: Vec<u8>,
        read_pos: usize,
        /// When the buffer is exhausted, return this error kind instead of EOF.
        exhausted_err: Option<ErrorKind>,
        /// The transport's currently configured read timeout.
        read_timeout: Option<Duration>,
        /// Every value passed to `set_read_timeout`, in order.
        set_history: Vec<Option<Duration>>,
        written_buf: Vec<u8>,
        /// Set once a `DONE` command has been written; cleared when the next
        /// read observes the timeout (that read is the DONE-response read).
        done_pending: bool,
        /// Timeout observed on the read that consumed the DONE response.
        done_read_timeout: Option<Option<Duration>>,
    }

    impl FakeStream {
        fn new(previous: Option<Duration>, script: &str, exhausted_err: Option<ErrorKind>) -> Self {
            FakeStream {
                read_buf: script.as_bytes().to_vec(),
                read_pos: 0,
                exhausted_err,
                read_timeout: previous,
                set_history: Vec::new(),
                written_buf: Vec::new(),
                done_pending: false,
                done_read_timeout: None,
            }
        }

        fn current_timeout(&self) -> Option<Duration> {
            self.read_timeout
        }

        fn done_read_timeout(&self) -> Option<Option<Duration>> {
            self.done_read_timeout
        }

        fn set_history(&self) -> &[Option<Duration>] {
            &self.set_history
        }
    }

    impl Read for FakeStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            // The first read after a `DONE` write reads the DONE response, so
            // it observes whatever timeout is currently configured on the
            // transport. Capture it exactly once.
            if self.done_pending {
                self.done_read_timeout = Some(self.read_timeout);
                self.done_pending = false;
            }
            if self.read_pos >= self.read_buf.len() {
                return match self.exhausted_err {
                    Some(kind) => Err(io::Error::new(kind, "FakeStream exhausted")),
                    None => Ok(0),
                };
            }
            buf[0] = self.read_buf[self.read_pos];
            self.read_pos += 1;
            Ok(1)
        }
    }

    impl Write for FakeStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written_buf.extend_from_slice(buf);
            if self.written_buf.ends_with(b"DONE") || self.written_buf.ends_with(b"DONE\r\n") {
                self.done_pending = true;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl SetReadTimeout for FakeStream {
        fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<()> {
            self.read_timeout = timeout;
            self.set_history.push(timeout);
            Ok(())
        }

        fn read_timeout(&self) -> Result<Option<Duration>> {
            Ok(self.read_timeout)
        }
    }

    fn login(stream: FakeStream) -> crate::Session<FakeStream> {
        Client::new(stream)
            .login("user", "pass")
            .expect("artificial login should succeed")
    }

    // previous Some(30s) -> wait change -> again Some(30s); the DONE-response
    // read saw the restored 30s, and a subsequent NOOP still sees 30s.
    #[test]
    fn restores_previous_some_after_mailbox_change() {
        let script = "a1 OK Logged in\r\n\
                      + idling\r\n\
                      * 1 EXISTS\r\n\
                      a2 OK IDLE terminated\r\n\
                      a3 OK NOOP completed\r\n";
        let mut session = login(FakeStream::new(Some(THIRTY), script, None));

        let outcome = session.idle().unwrap().wait_with_timeout(FIVE).unwrap();
        assert_eq!(outcome, WaitOutcome::MailboxChanged);

        {
            let s = session.stream.get_ref();
            assert_eq!(
                s.current_timeout(),
                Some(THIRTY),
                "timeout must be restored"
            );
            assert_eq!(
                s.done_read_timeout(),
                Some(Some(THIRTY)),
                "DONE read must be bounded by the restored timeout, not None"
            );
            assert_eq!(
                s.set_history(),
                &[Some(FIVE), Some(THIRTY)],
                "idle timeout set, then previous restored"
            );
        }

        session.noop().unwrap();
        assert_eq!(
            session.stream.get_ref().current_timeout(),
            Some(THIRTY),
            "timeout stays configured after IDLE + follow-up command"
        );
    }

    // IDLE read timeout surfaces as WaitOutcome::TimedOut; previous Some(30s) is
    // restored and the DONE read is bounded (not None).
    #[test]
    fn idle_timeout_wouldblock_restores_previous() {
        let script = "a1 OK Logged in\r\n+ idling\r\n";
        let mut session = login(FakeStream::new(
            Some(THIRTY),
            script,
            Some(ErrorKind::WouldBlock),
        ));

        let outcome = session.idle().unwrap().wait_with_timeout(FIVE).unwrap();
        assert_eq!(outcome, WaitOutcome::TimedOut);

        let s = session.stream.get_ref();
        assert_eq!(s.current_timeout(), Some(THIRTY));
        assert_eq!(s.done_read_timeout(), Some(Some(THIRTY)));
    }

    // Same as above but the socket reports TimedOut rather than WouldBlock.
    #[test]
    fn idle_timeout_timedout_restores_previous() {
        let script = "a1 OK Logged in\r\n+ idling\r\n";
        let mut session = login(FakeStream::new(
            Some(THIRTY),
            script,
            Some(ErrorKind::TimedOut),
        ));

        let outcome = session.idle().unwrap().wait_with_timeout(FIVE).unwrap();
        assert_eq!(outcome, WaitOutcome::TimedOut);

        let s = session.stream.get_ref();
        assert_eq!(s.current_timeout(), Some(THIRTY));
        assert_eq!(s.done_read_timeout(), Some(Some(THIRTY)));
    }

    // A genuine I/O failure during the wait is surfaced as Err, and the previous
    // Some(30s) is still restored (both on the normal path and on Drop).
    #[test]
    fn io_failure_during_wait_restores_previous() {
        let script = "a1 OK Logged in\r\n+ idling\r\n";
        let mut session = login(FakeStream::new(
            Some(THIRTY),
            script,
            Some(ErrorKind::Other),
        ));

        let res = session.idle().unwrap().wait_with_timeout(FIVE);
        assert!(res.is_err(), "I/O failure must propagate as an error");

        let s = session.stream.get_ref();
        assert_eq!(s.current_timeout(), Some(THIRTY), "restored on Err path");
        assert_eq!(
            s.done_read_timeout(),
            Some(Some(THIRTY)),
            "Drop/terminate read is bounded by the restored timeout"
        );
    }

    // A genuine None stays None after IDLE completes (no timeout is invented).
    #[test]
    fn previous_none_stays_none() {
        let script = "a1 OK Logged in\r\n\
                      + idling\r\n\
                      * 1 EXISTS\r\n\
                      a2 OK IDLE terminated\r\n";
        let mut session = login(FakeStream::new(None, script, None));

        let outcome = session.idle().unwrap().wait_with_timeout(FIVE).unwrap();
        assert_eq!(outcome, WaitOutcome::MailboxChanged);

        let s = session.stream.get_ref();
        assert_eq!(s.current_timeout(), None);
        assert_eq!(s.done_read_timeout(), Some(None));
        assert_eq!(s.set_history(), &[Some(FIVE), None]);
    }

    // Two sequential waits with different idle-timeouts must not overwrite the
    // originally configured 30s.
    #[test]
    fn sequential_waits_do_not_clobber_original() {
        let script = "a1 OK Logged in\r\n\
                      + idling\r\n\
                      * 1 EXISTS\r\n\
                      a2 OK IDLE terminated\r\n\
                      + idling\r\n\
                      * 2 EXISTS\r\n\
                      a3 OK IDLE terminated\r\n";
        let mut session = login(FakeStream::new(Some(THIRTY), script, None));

        let o1 = session.idle().unwrap().wait_with_timeout(FIVE).unwrap();
        assert_eq!(o1, WaitOutcome::MailboxChanged);
        let o2 = session.idle().unwrap().wait_with_timeout(SEVEN).unwrap();
        assert_eq!(o2, WaitOutcome::MailboxChanged);

        let s = session.stream.get_ref();
        assert_eq!(s.current_timeout(), Some(THIRTY));
        assert_eq!(
            s.set_history(),
            &[Some(FIVE), Some(THIRTY), Some(SEVEN), Some(THIRTY)],
            "each wait sets its idle timeout and restores the original 30s; no None leak"
        );
    }

    // The `SetReadTimeout` impl for `TcpStream` must delegate its getter to the
    // real socket. Verified over a loopback connection (no external network or
    // secrets). The `TlsStream` getter is the same one-line delegation to
    // `get_ref().read_timeout()` and is covered by inspection (constructing a
    // `TlsStream` would require real certificate/handshake infrastructure).
    #[test]
    fn tcpstream_read_timeout_getter_delegates() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut stream = TcpStream::connect(addr).unwrap();
        let _server = listener.accept().unwrap().0;

        SetReadTimeout::set_read_timeout(&mut stream, Some(THIRTY)).unwrap();
        assert_eq!(
            SetReadTimeout::read_timeout(&stream).unwrap(),
            Some(THIRTY),
            "TcpStream getter must report the configured timeout"
        );

        SetReadTimeout::set_read_timeout(&mut stream, None).unwrap();
        assert_eq!(SetReadTimeout::read_timeout(&stream).unwrap(), None);
    }
}
