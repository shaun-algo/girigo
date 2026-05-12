create table if not exists wishes (
  wish_id text primary key,
  submitted_at bigint not null,
  duration_sec integer not null default 5,
  devotion_seed integer not null,
  phase text not null default 'submission',
  granted boolean,
  video_file text,
  video_path text,
  video_size bigint,
  decree_at bigint
);

create index if not exists wishes_submitted_at_idx
  on wishes (submitted_at desc);

create index if not exists wishes_phase_idx
  on wishes (phase);
