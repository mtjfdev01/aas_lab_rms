CREATE TABLE bill_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sequence bigint GENERATED ALWAYS AS IDENTITY,
 tenant_id uuid NOT NULL,branch_id uuid NOT NULL,bill_id uuid NOT NULL,
 action text NOT NULL,actor_id uuid,actor_name_snapshot text,actor_staff_id_snapshot text,
 source_id uuid,data jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,branch_id,bill_id) REFERENCES bills(tenant_id,branch_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX bill_history_timeline ON bill_history(tenant_id,branch_id,bill_id,created_at,sequence);
ALTER TABLE bill_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_boundary ON bill_history FOR SELECT TO rms_app USING(tenant_id=tenant_scope() AND (branch_scope() IS NULL OR branch_id=branch_scope()));
GRANT SELECT ON bill_history TO rms_app;
CREATE TRIGGER immutable_bill_history BEFORE UPDATE OR DELETE ON bill_history FOR EACH ROW EXECUTE FUNCTION immutable_posting();
-- Preserve known legacy audit events without inventing historical staff-name snapshots.
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,source_id,data,created_at)
 SELECT a.tenant_id,b.branch_id,b.id,a.action,a.actor_id,a.target_id,a.data||jsonb_build_object('legacy',true),a.created_at
 FROM audit a JOIN bills b ON b.tenant_id=a.tenant_id AND b.id=a.target_id
 WHERE a.action LIKE 'bill.%';
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,source_id,data,created_at)
 SELECT a.tenant_id,p.branch_id,p.bill_id,a.action,a.actor_id,p.id,a.data||jsonb_build_object('legacy',true,'amount',p.amount,'kind',p.kind),a.created_at
 FROM audit a JOIN payments p ON p.tenant_id=a.tenant_id AND p.id=a.target_id
 WHERE p.bill_id IS NOT NULL AND a.action LIKE 'payment.%';
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,source_id,data,created_at)
 SELECT b.tenant_id,b.branch_id,b.id,'bill.created',b.generated_by,b.id,
 jsonb_build_object('legacy',true,'total',b.total,'discount',b.snapshot->'discount','note','Imported original bill; earlier unaudited transitions cannot be reconstructed'),b.created_at
 FROM bills b WHERE NOT EXISTS(SELECT 1 FROM bill_history h WHERE h.bill_id=b.id AND h.action IN ('bill.created','bill.finalized'));
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,source_id,data,created_at)
 SELECT j.tenant_id,j.branch_id,j.source_id,CASE WHEN j.reprint_of IS NULL THEN 'receipt.queued' ELSE 'receipt.reprint_queued' END,j.created_by,j.id,jsonb_build_object('legacy',true,'reprintOf',j.reprint_of),j.created_at FROM print_jobs j WHERE j.destination='bill';
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,source_id,data,created_at)
 SELECT a.tenant_id,j.branch_id,j.source_id,a.action,a.actor_id,j.id,a.data||jsonb_build_object('legacy',true),a.created_at FROM audit a JOIN print_jobs j ON j.id=a.target_id AND j.tenant_id=a.tenant_id WHERE j.destination='bill' AND a.action LIKE 'print.%';
INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,source_id,data)
 SELECT tenant_id,branch_id,id,'bill.history_imported',id,jsonb_build_object('legacy',true,'status',status,'note','Current status when bill history was introduced; exact earlier status transition times unavailable') FROM bills;
CREATE FUNCTION record_bill_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bill_ref uuid; actor_ref uuid; event_name text; details jsonb; actor_name text; actor_staff text;
BEGIN
 actor_ref:=nullif(current_setting('app.actor',true),'')::uuid;
 IF TG_TABLE_NAME='bills' THEN
  bill_ref:=NEW.id;
  IF TG_OP='INSERT' THEN
   actor_ref:=coalesce(actor_ref,NEW.generated_by);event_name:='bill.created';
   details:=jsonb_build_object('number',NEW.number,'total',NEW.total,'discount',NEW.snapshot->'discount','discountRule',NEW.snapshot->'discountRule','status',NEW.status);
  ELSE
   IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
   event_name:='bill.'||NEW.status;details:=jsonb_build_object('from',OLD.status,'to',NEW.status,'total',NEW.total);
  END IF;
 ELSIF TG_TABLE_NAME='payments' THEN
  bill_ref:=NEW.bill_id;IF bill_ref IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
   actor_ref:=coalesce(actor_ref,NEW.received_by);event_name:=CASE WHEN NEW.kind='refund' THEN 'payment.refunded' ELSE 'payment.recorded' END;
  ELSE
   IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
   event_name:='payment.'||NEW.status;
  END IF;
  details:=jsonb_build_object('amount',NEW.amount,'direction',NEW.direction,'kind',NEW.kind,'status',NEW.status,'accountId',NEW.account_id,'reference',NEW.reference,'note',NEW.note,'tendered',NEW.tendered,'refundOf',NEW.refund_of);
 ELSE
  IF NEW.destination<>'bill' THEN RETURN NEW; END IF;
  bill_ref:=NEW.source_id;
  IF TG_OP='INSERT' THEN actor_ref:=coalesce(actor_ref,NEW.created_by);event_name:=CASE WHEN NEW.reprint_of IS NULL THEN 'receipt.queued' ELSE 'receipt.reprint_queued' END;
  ELSE
   IF NEW.state IS NOT DISTINCT FROM OLD.state AND NEW.attempts=OLD.attempts THEN RETURN NEW; END IF;
   event_name:='receipt.'||NEW.state;
  END IF;
  details:=jsonb_build_object('state',NEW.state,'attempts',NEW.attempts,'error',NEW.error,'reprintOf',NEW.reprint_of);
 END IF;
 IF actor_ref IS NOT NULL THEN
  SELECT name,staff_id INTO actor_name,actor_staff FROM users WHERE id=actor_ref AND tenant_id=NEW.tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill history actor tenant mismatch'; END IF;
 END IF;
 INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,actor_name_snapshot,actor_staff_id_snapshot,source_id,data)
 VALUES(NEW.tenant_id,NEW.branch_id,bill_ref,event_name,actor_ref,actor_name,actor_staff,NEW.id,details);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION record_bill_history() FROM PUBLIC;
CREATE TRIGGER bill_history_status AFTER INSERT OR UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION record_bill_history();
CREATE TRIGGER bill_history_payment AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION record_bill_history();
CREATE TRIGGER bill_history_receipt AFTER INSERT OR UPDATE ON print_jobs FOR EACH ROW EXECUTE FUNCTION record_bill_history();
-- Retain reasons/approvals that are audited after the corresponding status change.
CREATE FUNCTION bill_history_reason() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bill_ref uuid; actor_name text; actor_staff text;
BEGIN
 IF NEW.action NOT IN ('bill.voided','print.reprint') THEN RETURN NEW; END IF;
 IF NEW.action='bill.voided' THEN bill_ref:=NEW.target_id;
 ELSE SELECT source_id INTO bill_ref FROM print_jobs WHERE id=NEW.target_id AND tenant_id=NEW.tenant_id AND destination='bill'; END IF;
 IF bill_ref IS NULL THEN RETURN NEW; END IF;
 SELECT name,staff_id INTO actor_name,actor_staff FROM users WHERE id=NEW.actor_id AND tenant_id=NEW.tenant_id;
 INSERT INTO bill_history(tenant_id,branch_id,bill_id,action,actor_id,actor_name_snapshot,actor_staff_id_snapshot,source_id,data)
 VALUES(NEW.tenant_id,NEW.branch_id,bill_ref,NEW.action||'.reason',NEW.actor_id,actor_name,actor_staff,NEW.target_id,NEW.data);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION bill_history_reason() FROM PUBLIC;
CREATE TRIGGER bill_history_audit_reason AFTER INSERT ON audit FOR EACH ROW EXECUTE FUNCTION bill_history_reason();
