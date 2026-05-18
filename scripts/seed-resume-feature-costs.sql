INSERT INTO "FeatureCost" (id, "featureKey", credits, label, "isActive", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'resume_generate',        1.00, 'Resume - AI Generation',                true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_enhance_section', 1.00, 'Resume - Enhance Section',              true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_tailor',          4.00, 'Resume - JD Tailoring',                 true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_extract_fields',  2.00, 'Resume - Extract Fields (Resume Parse)',true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_rewrite',         4.00, 'Resume - AI Rewrite',                   true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_inject_skills',   1.00, 'Resume - Inject Skills',                true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_inject_keywords', 2.00, 'Resume - Keyword Injection',            true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_cover_letter',    1.00, 'Resume - Cover Letter Generation',      true, NOW(), NOW()),
  (gen_random_uuid(), 'resume_ats_score',       2.00, 'Resume - ATS Analysis',                 true, NOW(), NOW())
ON CONFLICT ("featureKey") DO NOTHING;
