-- Development only. Replace both passwords and use managed secret injection in production.
CREATE ROLE rms_app LOGIN PASSWORD 'local_app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE rms TO rms_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
