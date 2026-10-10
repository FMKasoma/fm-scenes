-- fm_scenes rolling schema (fresh installations and existing servers)
-- Safe to re-run. Does not drop or truncate data.
CREATE TABLE IF NOT EXISTS fm_scenes (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 owner VARCHAR(128) NOT NULL,
 text VARCHAR(220) NOT NULL,
 x DOUBLE NOT NULL, y DOUBLE NOT NULL, z DOUBLE NOT NULL,
 area_id VARCHAR(128) NOT NULL DEFAULT '',
 region_id VARCHAR(128) NOT NULL DEFAULT '',
 virtual_world INT NOT NULL DEFAULT 0,
 view_distance DOUBLE NOT NULL DEFAULT 800,
 style_json TEXT NOT NULL,
 created_at BIGINT NOT NULL,
 expires_at BIGINT NULL,
 INDEX idx_owner(owner), INDEX idx_expiry(expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS fm_scenes_preferences (
 owner VARCHAR(128) NOT NULL PRIMARY KEY,
 mode ENUM('always','hold','toggle') NOT NULL DEFAULT 'always'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
