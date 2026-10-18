pub mod contacts;
pub mod edit;
pub mod filter;
pub mod folders;
pub mod groups;
pub mod invite;
pub mod kitty;
pub mod attachments;
pub mod incoming;
pub mod media;
pub mod protocol;
pub mod messages;
pub mod reactions;
pub mod read_receipts;
/// M2.3: Call signal model (parity JS features/calls.js parseCallSignal).
pub mod call;
pub mod relay;
pub mod search;
pub mod status;
pub mod thread;

pub use contacts::ContactBook;
pub use edit::EditManager;
pub use filter::VaultFilter;
pub use folders::FolderStore;
pub use groups::GroupManager;
pub use invite::InviteManager;
pub use media::{MediaInfo, ThumbnailManager, ThumbnailSize};
pub use reactions::{Reaction, ReactionStore};
pub use attachments::{AttachmentMeta, AttachmentStore, EncryptedEnvelope, EncryptedEnvelopeData, download_file};
pub use messages::{VaultMessage, MessageStore};
pub use incoming::{ClassifyKind, ClassifyResult, classify};
/// M2.3: Call signal core (parity JS parseCallSignal + CallSignal).
pub use call::{CallSignal, parse_call_signal};
pub use read_receipts::ReadReceiptStore;
pub use search::{IndexEntry, MessageIndex};
