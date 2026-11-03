CREATE OR REPLACE FUNCTION check_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (SELECT COALESCE(sum(amount),0) FROM journal_lines WHERE journal_id=NEW.journal_id)<>0 THEN RAISE EXCEPTION 'Unbalanced journal'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION check_journal_lines() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (SELECT count(*) FROM journal_lines WHERE journal_id=NEW.id)<2 OR (SELECT COALESCE(sum(amount),0) FROM journal_lines WHERE journal_id=NEW.id)<>0 THEN RAISE EXCEPTION 'Journal needs balanced posting lines'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_has_lines AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_journal_lines();
ALTER TABLE journal_lines ADD CONSTRAINT ledger_account_branch FOREIGN KEY(tenant_id,branch_id,account_id) REFERENCES accounts(tenant_id,branch_id,id);
ALTER TABLE customers ADD CONSTRAINT customer_session_unique UNIQUE(tenant_id,branch_id,session_id,id);
ALTER TABLE orders ADD CONSTRAINT order_customer_session FOREIGN KEY(tenant_id,branch_id,session_id,customer_id) REFERENCES customers(tenant_id,branch_id,session_id,id);
