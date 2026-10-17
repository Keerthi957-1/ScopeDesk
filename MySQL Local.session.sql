-- ============================================================
-- ScopeDesk Database Schema (MySQL 8.0+)
-- ============================================================

CREATE DATABASE IF NOT EXISTS scopedesk
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE scopedesk;

-- ------------------------------------------------------------
-- 1. USERS (sign-up / login, both roles)
-- ------------------------------------------------------------
CREATE TABLE users (
    user_id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(50)  NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,          -- Argon2id / bcrypt hash, NEVER plaintext
    role            ENUM('client','vendor') NOT NULL,
    organization    VARCHAR(150) NULL,              -- office name or vendor company
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    failed_logins   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until    DATETIME NULL,
    last_login_at   DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                    ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 2. SUPPORT TASKS (what the vendor is allowed to work on)
-- ------------------------------------------------------------
CREATE TABLE support_tasks (
    task_id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    client_id       BIGINT UNSIGNED NOT NULL,
    vendor_id       BIGINT UNSIGNED NULL,           -- set when vendor joins
    title           VARCHAR(150) NOT NULL,
    description     TEXT NULL,
    target_process  VARCHAR(255) NOT NULL,          -- e.g. 'erp.exe', 'billing.exe'
    target_window   VARCHAR(255) NULL,              -- optional window title match
    status          ENUM('pending','active','completed','expired','terminated')
                    NOT NULL DEFAULT 'pending',
    window_start    DATETIME NOT NULL,
    window_end      DATETIME NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_task_client FOREIGN KEY (client_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_task_vendor FOREIGN KEY (vendor_id) REFERENCES users(user_id) ON DELETE SET NULL,
    CONSTRAINT chk_task_window CHECK (window_end > window_start),
    INDEX idx_task_client (client_id),
    INDEX idx_task_vendor (vendor_id),
    INDEX idx_task_status (status)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 3. APPROVED PROCESSES (extra whitelist per task)
--    e.g. allow the ERP app plus a helper dialog it spawns
-- ------------------------------------------------------------
CREATE TABLE task_allowed_processes (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id         BIGINT UNSIGNED NOT NULL,
    process_name    VARCHAR(255) NOT NULL,
    process_path    VARCHAR(500) NULL,
    CONSTRAINT fk_allowed_task FOREIGN KEY (task_id) REFERENCES support_tasks(task_id) ON DELETE CASCADE,
    UNIQUE KEY uq_task_process (task_id, process_name)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 4. SESSION TOKENS (time-bound handshake tokens)
--    Store only a HASH of the token; the raw token is shown once.
-- ------------------------------------------------------------
CREATE TABLE session_tokens (
    token_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id         BIGINT UNSIGNED NOT NULL,
    client_id       BIGINT UNSIGNED NOT NULL,
    token_hash      CHAR(64) NOT NULL UNIQUE,       -- SHA-256 hex of the token
    client_ip       VARCHAR(45) NOT NULL,           -- IPv4 or IPv6
    client_port     SMALLINT UNSIGNED NOT NULL,
    issued_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at      DATETIME NOT NULL,
    is_used         TINYINT(1) NOT NULL DEFAULT 0,  -- single-use handshake
    used_at         DATETIME NULL,
    is_revoked      TINYINT(1) NOT NULL DEFAULT 0,
    CONSTRAINT fk_token_task   FOREIGN KEY (task_id)   REFERENCES support_tasks(task_id) ON DELETE CASCADE,
    CONSTRAINT fk_token_client FOREIGN KEY (client_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_token_expiry (expires_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 5. REMOTE SESSIONS (one row per actual connection)
-- ------------------------------------------------------------
CREATE TABLE remote_sessions (
    session_id      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id         BIGINT UNSIGNED NOT NULL,
    token_id        BIGINT UNSIGNED NOT NULL,
    vendor_id       BIGINT UNSIGNED NOT NULL,
    vendor_ip       VARCHAR(45) NULL,
    started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME NULL,
    end_reason      ENUM('completed','timeout','client_ended',
                         'intrusion_kill','token_revoked','error') NULL,
    CONSTRAINT fk_sess_task   FOREIGN KEY (task_id)   REFERENCES support_tasks(task_id)   ON DELETE CASCADE,
    CONSTRAINT fk_sess_token  FOREIGN KEY (token_id)  REFERENCES session_tokens(token_id) ON DELETE CASCADE,
    CONSTRAINT fk_sess_vendor FOREIGN KEY (vendor_id) REFERENCES users(user_id)           ON DELETE CASCADE,
    INDEX idx_sess_task (task_id)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 6. INTRUSION / SECURITY EVENTS (alerts + auto-kill log)
-- ------------------------------------------------------------
CREATE TABLE intrusion_events (
    event_id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    session_id      BIGINT UNSIGNED NOT NULL,
    event_type      ENUM('window_minimized','unapproved_process',
                         'focus_lost','window_closed','unauthorized_tool')
                    NOT NULL,
    process_name    VARCHAR(255) NULL,
    details         TEXT NULL,
    severity        ENUM('warning','critical') NOT NULL DEFAULT 'warning',
    action_taken    ENUM('alert_only','connection_dropped') NOT NULL DEFAULT 'alert_only',
    occurred_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_event_session FOREIGN KEY (session_id) REFERENCES remote_sessions(session_id) ON DELETE CASCADE,
    INDEX idx_event_session (session_id),
    INDEX idx_event_time (occurred_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------
-- 7. AUDIT LOG (login, token creation, config changes, etc.)
-- ------------------------------------------------------------
CREATE TABLE audit_log (
    log_id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NULL,
    action          VARCHAR(100) NOT NULL,          -- 'LOGIN','LOGIN_FAILED','TOKEN_CREATED',...
    ip_address      VARCHAR(45) NULL,
    details         JSON NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_action (action)
) ENGINE=InnoDB;

-- ============================================================
-- STORED PROCEDURES
-- ============================================================
DELIMITER $$

-- Register a user (hash is computed in the app, not in SQL)
CREATE PROCEDURE sp_register_user(
    IN p_username VARCHAR(50), IN p_email VARCHAR(255),
    IN p_password_hash VARCHAR(255), IN p_role ENUM('client','vendor'),
    IN p_org VARCHAR(150))
BEGIN
    INSERT INTO users (username, email, password_hash, role, organization)
    VALUES (p_username, p_email, p_password_hash, p_role, p_org);
    SELECT LAST_INSERT_ID() AS user_id;
END$$

-- Create a task + its token in one transaction
CREATE PROCEDURE sp_create_task_with_token(
    IN p_client_id BIGINT UNSIGNED, IN p_title VARCHAR(150),
    IN p_target_process VARCHAR(255), IN p_window_minutes INT,
    IN p_token_hash CHAR(64), IN p_client_ip VARCHAR(45),
    IN p_client_port SMALLINT UNSIGNED)
BEGIN
    DECLARE v_task_id BIGINT UNSIGNED;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION BEGIN ROLLBACK; RESIGNAL; END;

    START TRANSACTION;
        INSERT INTO support_tasks (client_id, title, target_process, window_start, window_end)
        VALUES (p_client_id, p_title, p_target_process,
                NOW(), DATE_ADD(NOW(), INTERVAL p_window_minutes MINUTE));
        SET v_task_id = LAST_INSERT_ID();

        INSERT INTO task_allowed_processes (task_id, process_name)
        VALUES (v_task_id, p_target_process);

        INSERT INTO session_tokens (task_id, client_id, token_hash, client_ip,
                                    client_port, expires_at)
        VALUES (v_task_id, p_client_id, p_token_hash, p_client_ip, p_client_port,
                DATE_ADD(NOW(), INTERVAL p_window_minutes MINUTE));
    COMMIT;
    SELECT v_task_id AS task_id;
END$$

-- Validate a token presented by the vendor (single use, not expired/revoked)
CREATE PROCEDURE sp_redeem_token(
    IN p_token_hash CHAR(64), IN p_vendor_id BIGINT UNSIGNED, IN p_vendor_ip VARCHAR(45))
BEGIN
    DECLARE v_token_id BIGINT UNSIGNED;
    DECLARE v_task_id  BIGINT UNSIGNED;

    SELECT token_id, task_id INTO v_token_id, v_task_id
    FROM session_tokens
    WHERE token_hash = p_token_hash
      AND is_used = 0 AND is_revoked = 0
      AND expires_at > NOW()
    FOR UPDATE;

    IF v_token_id IS NULL THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Invalid, used, revoked or expired token';
    END IF;

    UPDATE session_tokens SET is_used = 1, used_at = NOW() WHERE token_id = v_token_id;
    UPDATE support_tasks  SET status = 'active', vendor_id = p_vendor_id WHERE task_id = v_task_id;

    INSERT INTO remote_sessions (task_id, token_id, vendor_id, vendor_ip)
    VALUES (v_task_id, v_token_id, p_vendor_id, p_vendor_ip);

    SELECT LAST_INSERT_ID() AS session_id, v_task_id AS task_id;
END$$

-- Log an intrusion and (optionally) terminate the session
CREATE PROCEDURE sp_log_intrusion(
    IN p_session_id BIGINT UNSIGNED, IN p_event_type VARCHAR(30),
    IN p_process_name VARCHAR(255), IN p_details TEXT, IN p_kill TINYINT)
BEGIN
    INSERT INTO intrusion_events
        (session_id, event_type, process_name, details, severity, action_taken)
    VALUES (p_session_id, p_event_type, p_process_name, p_details,
            IF(p_kill = 1, 'critical', 'warning'),
            IF(p_kill = 1, 'connection_dropped', 'alert_only'));

    IF p_kill = 1 THEN
        UPDATE remote_sessions
           SET ended_at = NOW(), end_reason = 'intrusion_kill'
         WHERE session_id = p_session_id AND ended_at IS NULL;

        UPDATE support_tasks t
          JOIN remote_sessions s ON s.task_id = t.task_id
           SET t.status = 'terminated'
         WHERE s.session_id = p_session_id;
    END IF;
END$$

DELIMITER ;

-- ============================================================
-- EVENT: auto-expire tokens and tasks every minute
-- (requires: SET GLOBAL event_scheduler = ON;)
-- ============================================================
CREATE EVENT IF NOT EXISTS ev_expire_tasks
ON SCHEDULE EVERY 1 MINUTE
DO
BEGIN
    UPDATE support_tasks
       SET status = 'expired'
     WHERE status IN ('pending','active') AND window_end < NOW();

    UPDATE remote_sessions s
      JOIN support_tasks t ON t.task_id = s.task_id
       SET s.ended_at = NOW(), s.end_reason = 'timeout'
     WHERE t.status = 'expired' AND s.ended_at IS NULL;
END;

-- ============================================================
-- USEFUL VIEW: security report per session
-- ============================================================
CREATE VIEW v_session_security_report AS
SELECT s.session_id, t.title, t.target_process,
       cu.username AS client, vu.username AS vendor,
       s.started_at, s.ended_at, s.end_reason,
       COUNT(e.event_id) AS total_events,
       SUM(e.severity = 'critical') AS critical_events
FROM remote_sessions s
JOIN support_tasks t ON t.task_id = s.task_id
JOIN users cu ON cu.user_id = t.client_id
JOIN users vu ON vu.user_id = s.vendor_id
LEFT JOIN intrusion_events e ON e.session_id = s.session_id
GROUP BY s.session_id;