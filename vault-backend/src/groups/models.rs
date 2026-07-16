use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Group {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub avatar_url: Option<String>,
    pub owner_id: Uuid,
    pub invite_code: Option<String>,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct GroupMember {
    pub id: Uuid,
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub left_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: Uuid,
    pub role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GroupResponse {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<Group> for GroupResponse {
    fn from(group: Group) -> Self {
        GroupResponse {
            id: group.id,
            name: group.name,
            description: group.description,
            owner_id: group.owner_id,
            created_at: group.created_at,
            updated_at: group.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GroupMemberResponse {
    pub id: Uuid,
    pub group_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
}

impl From<GroupMember> for GroupMemberResponse {
    fn from(member: GroupMember) -> Self {
        GroupMemberResponse {
            id: member.id,
            group_id: member.group_id,
            user_id: member.user_id,
            role: member.role,
            joined_at: member.joined_at,
        }
    }
}
