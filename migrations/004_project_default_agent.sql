ALTER TABLE projects
  ADD COLUMN default_agent TEXT NOT NULL DEFAULT 'codex';

UPDATE projects
SET default_agent = json_extract(allowed_agents_json, '$[0]')
WHERE json_array_length(allowed_agents_json) = 1;
