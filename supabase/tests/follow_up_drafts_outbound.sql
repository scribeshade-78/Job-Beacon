begin;
select plan(6);

select has_column('public', 'follow_up_drafts', 'subject', 'the draft carries the subject the candidate approved');
select has_column('public', 'follow_up_drafts', 'recipient_message_id', 'the send records WHICH message proved the recipient address');
select has_column('public', 'follow_up_drafts', 'provider_message_id', 'the send records the transport message id');
select col_is_null('public', 'follow_up_drafts', 'sent_at', 'sent_at is nullable, so a legacy approval is distinguishable from a real send');

-- 'sending' is the claimed state the delivery loop depends on; without it a crash mid-send has
-- nowhere to be recorded.
select ok(
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'follow_up_drafts_status_check') like '%sending%',
  'the status constraint admits the CLAIMED state'
);

select ok(
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'follow_up_drafts_sending_idx'),
  'the recovery pass has a partial index over stuck claims'
);

select * from finish();
rollback;
