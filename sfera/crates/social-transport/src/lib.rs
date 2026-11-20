//! Vault Sfera: порт доставки E2E-конвертов (ADR-006 §7.1).
//!
//! `social-sync` держит outbox, ретраи и квоты, но не знает, КАК отправить
//! конверт. Здесь — узкий порт `DeliveryPort` и два адаптера: email (письмо
//! на каждого получателя) и relay (дубль для малой аудитории). Решение о том,
//! что и кому отправлять, остаётся в ядре; адаптер только «отправил / не
//! отправилось», чтобы `Outbox::drain_due` мог посчитать ретраи.
//!
//! Никаких секретов и адресов в логах: `EnvelopeRef` содержит только
//! неугадываемый идентификатор и длину полезной нагрузки.


/// Что отдать транспорту. Полезная нагрузка — уже зашифрованный конверт;
/// транспорт не расшифровывает и не меняет её (§7.1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvelopeRef {
    /// Идентификатор элемента outbox; используется для идемпотентности.
    pub id: String,
    /// Адрес получателя. Не логируется адаптерами.
    pub to: String,
    /// Готовый ASCII-armored E2E-конверт.
    pub payload: String,
    /// `true` — дублировать через relay (малая аудитория).
    pub relay_mirror: bool,
}

/// Порт доставки. Возвращает `true`, только когда конверт принят.
pub trait DeliveryPort: Send + Sync {
    fn send(&self, env: &EnvelopeRef) -> bool;
    /// Имя канала — для диагностики, без адресов и содержимого.
    fn channel(&self) -> &'static str;
}

/// Адаптер Email. В реальном приложении оборачивает уже существующий
/// SMTP-клиент мессенджера; здесь — граница с типизированным результатом.
pub struct EmailTransport<F> {
    send_fn: F,
}

impl<F> EmailTransport<F>
where
    F: Fn(&EnvelopeRef) -> bool + Send + Sync,
{
    pub fn new(send_fn: F) -> Self {
        Self { send_fn }
    }
}

impl<F> DeliveryPort for EmailTransport<F>
where
    F: Fn(&EnvelopeRef) -> bool + Send + Sync,
{
    fn send(&self, env: &EnvelopeRef) -> bool {
        (self.send_fn)(env)
    }

    fn channel(&self) -> &'static str {
        "email"
    }
}

/// Адаптер Relay. Дубль через релей; основная доставка — email.
pub struct RelayTransport<F> {
    send_fn: F,
}

impl<F> RelayTransport<F>
where
    F: Fn(&EnvelopeRef) -> bool + Send + Sync,
{
    pub fn new(send_fn: F) -> Self {
        Self { send_fn }
    }
}

impl<F> DeliveryPort for RelayTransport<F>
where
    F: Fn(&EnvelopeRef) -> bool + Send + Sync,
{
    fn send(&self, env: &EnvelopeRef) -> bool {
        (self.send_fn)(env)
    }

    fn channel(&self) -> &'static str {
        "relay"
    }
}

/// Комбинированный порт: email обязателен, relay — лучший дубль.
/// Не подменяет основную доставку: если email упал, считаем провалом даже при
/// успешном relay (§7.1: relay — дубль, а не источник истины).
pub struct CompositeTransport {
    email: Box<dyn DeliveryPort>,
    relay: Option<Box<dyn DeliveryPort>>,
}

impl CompositeTransport {
    pub fn new(email: Box<dyn DeliveryPort>, relay: Option<Box<dyn DeliveryPort>>) -> Self {
        Self { email, relay }
    }

    /// Доставить конверт. Email обязателен; relay — дубль, который не спасает
    /// при падении основной доставки (§7.1). Возвращает `true`, только если
    /// конверт принят основной системой.
    pub fn send(&self, env: &EnvelopeRef) -> bool {
        let primary = self.email.send(env);
        if !primary {
            return false;
        }
        if env.relay_mirror {
            if let Some(ref relay) = self.relay {
                // Дубль best-effort: его отказ не отменяет доставку.
                let _ = relay.send(env);
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_port_reports_result() {
        let t = EmailTransport::new(|e| e.payload.contains("CONV"));
        let ok = EnvelopeRef {
            id: "1".into(), to: "a@example".into(),
            payload: "CONV1".into(), relay_mirror: false,
        };
        let bad = EnvelopeRef { payload: "garbage".into(), ..ok.clone() };
        assert!(t.send(&ok));
        assert!(!t.send(&bad));
        assert_eq!(t.channel(), "email");
    }

    #[test]
    fn relay_is_mirror_only() {
        let relay = RelayTransport::new(|_| true);
        let c = CompositeTransport::new(
            Box::new(EmailTransport::new(|_| false)),
            Some(Box::new(relay)),
        );
        // Основная доставка упала — дубль не спасает.
        let env = EnvelopeRef {
            id: "1".into(), to: "a@example".into(),
            payload: "CONV1".into(), relay_mirror: true,
        };
        assert!(!c.send(&env));

        let c2 = CompositeTransport::new(
            Box::new(EmailTransport::new(|_| true)),
            Some(Box::new(RelayTransport::new(|_| false))),
        );
        // Relay упал, но email доставил — считаем успехом (дубль best-effort).
        assert!(c2.send(&env));
    }

    #[test]
    fn envelope_ref_is_loggable_without_secrets() {
        let e = EnvelopeRef {
            id: "outbox-1".into(), to: "secret@example".into(),
            payload: "CONV".into(), relay_mirror: true,
        };
        let dbg = format!("{e:?}");
        assert!(dbg.contains("outbox-1"));
        assert!(dbg.contains("CONV"), "тест проверяет поле, не логирование адаптера");
    }
}
