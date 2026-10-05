ALTER TABLE pdfs
  ADD COLUMN IF NOT EXISTS doc_kind TEXT;

ALTER TABLE curriculum_links
  ADD COLUMN IF NOT EXISTS syllabus_kind TEXT,
  ADD COLUMN IF NOT EXISTS learner_book_kind TEXT,
  ADD COLUMN IF NOT EXISTS teacher_guide_kind TEXT;

UPDATE pdfs
SET doc_kind = CASE
  WHEN lower(url) ~ '^https?://elearn\.ncdc\.go\.ug/viewer(/|[?#]|$)' THEN 'viewer'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.pdf$' THEN 'pdf'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(jpg|jpeg|png|gif|webp|bmp|svg)$' THEN 'image'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(doc|docx|odt|rtf)$' THEN 'document'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(xls|xlsx|ods|csv)$' THEN 'spreadsheet'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(ppt|pptx|odp)$' THEN 'presentation'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(mp4|webm|mov|avi|mkv)$' THEN 'video'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(mp3|wav|m4a|ogg)$' THEN 'audio'
  WHEN regexp_replace(lower(url), '[?#].*$', '') ~ '\.(txt|md)$' THEN 'text'
  ELSE 'other'
END;

UPDATE curriculum_links
SET syllabus_kind = CASE
      WHEN NULLIF(BTRIM(syllabus_url), '') IS NULL THEN NULL
      WHEN lower(syllabus_url) ~ '^https?://elearn\.ncdc\.go\.ug/viewer(/|[?#]|$)' THEN 'viewer'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.pdf$' THEN 'pdf'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(jpg|jpeg|png|gif|webp|bmp|svg)$' THEN 'image'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(doc|docx|odt|rtf)$' THEN 'document'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(xls|xlsx|ods|csv)$' THEN 'spreadsheet'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(ppt|pptx|odp)$' THEN 'presentation'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(mp4|webm|mov|avi|mkv)$' THEN 'video'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(mp3|wav|m4a|ogg)$' THEN 'audio'
      WHEN regexp_replace(lower(syllabus_url), '[?#].*$', '') ~ '\.(txt|md)$' THEN 'text'
      ELSE 'other'
    END,
    learner_book_kind = CASE
      WHEN NULLIF(BTRIM(learner_book_url), '') IS NULL THEN NULL
      WHEN lower(learner_book_url) ~ '^https?://elearn\.ncdc\.go\.ug/viewer(/|[?#]|$)' THEN 'viewer'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.pdf$' THEN 'pdf'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(jpg|jpeg|png|gif|webp|bmp|svg)$' THEN 'image'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(doc|docx|odt|rtf)$' THEN 'document'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(xls|xlsx|ods|csv)$' THEN 'spreadsheet'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(ppt|pptx|odp)$' THEN 'presentation'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(mp4|webm|mov|avi|mkv)$' THEN 'video'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(mp3|wav|m4a|ogg)$' THEN 'audio'
      WHEN regexp_replace(lower(learner_book_url), '[?#].*$', '') ~ '\.(txt|md)$' THEN 'text'
      ELSE 'other'
    END,
    teacher_guide_kind = CASE
      WHEN NULLIF(BTRIM(teacher_guide_url), '') IS NULL THEN NULL
      WHEN lower(teacher_guide_url) ~ '^https?://elearn\.ncdc\.go\.ug/viewer(/|[?#]|$)' THEN 'viewer'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.pdf$' THEN 'pdf'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(jpg|jpeg|png|gif|webp|bmp|svg)$' THEN 'image'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(doc|docx|odt|rtf)$' THEN 'document'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(xls|xlsx|ods|csv)$' THEN 'spreadsheet'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(ppt|pptx|odp)$' THEN 'presentation'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(mp4|webm|mov|avi|mkv)$' THEN 'video'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(mp3|wav|m4a|ogg)$' THEN 'audio'
      WHEN regexp_replace(lower(teacher_guide_url), '[?#].*$', '') ~ '\.(txt|md)$' THEN 'text'
      ELSE 'other'
    END;
