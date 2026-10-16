begin;
select plan(3);

select has_column(
  'public', 'messages', 'auth_results',
  'messages carries the receiving provider authentication verdict'
);

select col_type_is(
  'public', 'messages', 'auth_results', 'text',
  'it is free text - the header is provider-specific and must not be pre-parsed into a boolean'
);

select col_is_null(
  'public', 'messages', 'auth_results',
  'NULL means UNKNOWN, so the matcher cannot read absence as a pass'
);

select * from finish();
rollback;
