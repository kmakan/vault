use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::middleware::AuthExtractor;
use super::models::{
    AddMemberRequest, CreateGroupRequest, Group, GroupMember, GroupMemberResponse, GroupResponse,
};

pub async fn list_groups(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
) -> Result<Json<Vec<GroupResponse>>, (StatusCode, String)> {
    let groups = sqlx::query_as::<_, Group>(
        "SELECT g.* FROM groups g
         INNER JOIN group_members gm ON gm.group_id = g.id
         WHERE gm.user_id = $1 AND g.is_active = TRUE
         ORDER BY g.created_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(groups.into_iter().map(GroupResponse::from).collect()))
}

pub async fn create_group(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Json(req): Json<CreateGroupRequest>,
) -> Result<(StatusCode, Json<GroupResponse>), (StatusCode, String)> {
    let group = sqlx::query_as::<_, Group>(
        "INSERT INTO groups (name, description, owner_id)
         VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(&req.name)
    .bind(&req.description)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query(
        "INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'admin')",
    )
    .bind(group.id)
    .bind(auth.user_id)
    .execute(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(GroupResponse::from(group))))
}

pub async fn get_group(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
) -> Result<Json<GroupResponse>, (StatusCode, String)> {
    let is_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1 FROM group_members
            WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL
        )",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !is_member {
        return Err((StatusCode::NOT_FOUND, "Group not found or not a member".to_string()));
    }

    let group = sqlx::query_as::<_, Group>(
        "SELECT * FROM groups WHERE id = $1 AND is_active = TRUE",
    )
    .bind(group_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match group {
        Some(group) => Ok(Json(GroupResponse::from(group))),
        None => Err((StatusCode::NOT_FOUND, "Group not found".to_string())),
    }
}

pub async fn add_member(
    State(pool): State<PgPool>,
    auth: AuthExtractor,
    Path(group_id): Path<Uuid>,
    Json(req): Json<AddMemberRequest>,
) -> Result<(StatusCode, Json<GroupMemberResponse>), (StatusCode, String)> {
    let caller_role = sqlx::query_scalar::<_, Option<String>>(
        "SELECT role FROM group_members
         WHERE group_id = $1 AND user_id = $2 AND left_at IS NULL",
    )
    .bind(group_id)
    .bind(auth.user_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match caller_role.flatten().as_deref() {
        Some("admin") => {}
        _ => {
            return Err((
                StatusCode::FORBIDDEN,
                "Only admins can add members".to_string(),
            ))
        }
    }

    let user_exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)",
    )
    .bind(req.user_id)
    .fetch_one(&pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !user_exists {
        return Err((StatusCode::NOT_FOUND, "User not found".to_string()));
    }

    let role = req.role.as_deref().unwrap_or("member");

    let member = sqlx::query_as::<_, GroupMember>(
        "INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(group_id)
    .bind(req.user_id)
    .bind(role)
    .fetch_one(&pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("duplicate key") {
            (
                StatusCode::CONFLICT,
                "User is already a member".to_string(),
            )
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        }
    })?;

    Ok((StatusCode::CREATED, Json(GroupMemberResponse::from(member))))
}
