begin;
select plan(3);

select has_column(
  'public', 'messages', 'recipient',
  'messages carries the recipient header the reply token arrives in'
);

select col_type_is(
  'public', 'messages', 'recipient', 'text',
  'it is stored raw - the token is parsed at match time, not at write time'
);

select col_is_null(
  'public', 'messages', 'recipient',
  'NULL means NOT CAPTURED, so it cannot be read as "this message has no token"'
);

select * from finish();
rollback;
