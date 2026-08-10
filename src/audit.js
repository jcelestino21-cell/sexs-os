const db = require('../db');

function logAudit({ actorUserId = null, actorLabel, action, entityType = null, entityId = null, details = null }) {
  db.prepare(
    `INSERT INTO audit_log (actor_user_id, actor_label, action, entity_type, entity_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(actorUserId, actorLabel, action, entityType, entityId, details ? JSON.stringify(details) : null);
}

module.exports = { logAudit };
