import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSelectedProjectsUnavailableContext,
  classifyComplexity,
  detectFollowupIntent,
  extractCandidateProfileContext,
  extractResumeProjectContext,
  extractRelevantProjectContext,
  isExplicitProjectDetailQuestion,
  isProjectExperienceQuestion,
  shouldUseResumeBackedProjectFallback,
} from "./cie.service";

test("CIE treats code and scenario continuations as followups", () => {
  assert.equal(detectFollowupIntent("Can you explain the code again?"), true);
  assert.equal(classifyComplexity("Can you explain the code again?"), "followup");
  assert.equal(classifyComplexity("continue from database part"), "followup");
  assert.equal(classifyComplexity("why this is used"), "followup");
  assert.equal(classifyComplexity("optimize this"), "followup");
});

test("CIE treats ecommerce inventory scenario setup as scenario, not followup", () => {
  assert.equal(
    classifyComplexity(
      "Scenario setup: ecommerce sale, multiple users buying same product, inventory left 5, orders are going negative. Question: How will you tackle this issue?",
    ),
    "scenario_based",
  );
});

test("CIE keeps long explicit ecommerce scenario as scenario, not system design", () => {
  assert.equal(
    classifyComplexity(
      [
        "Scenario setup: suppose there is an ecommerce flash sale running in production with very high traffic.",
        "Multiple users are trying to buy the same product at the same time from checkout and payment services.",
        "Inventory left is 5, but due to concurrent requests and race conditions the system creates negative orders and oversells stock.",
        "The interviewer asks how would you handle, fix, prevent, and monitor this issue end to end.",
      ].join(" "),
    ),
    "scenario_based",
  );
});

test("CIE routes Parakeet data-processing scenario and SQL join-count problem separately", () => {
  assert.equal(
    classifyComplexity("You have to process 1TB data daily from S3. What cluster size, nodes, and monitoring would you use?"),
    "scenario_based",
  );
  assert.equal(
    classifyComplexity("For given table1 and table2, count records for inner join, left join, right join, and full join on number column."),
    "simple_atomic",
  );
});

test("CIE treats experience years and responsibilities as context questions", () => {
  assert.equal(isProjectExperienceQuestion("How many years of experience do you have?"), true);
  assert.equal(isProjectExperienceQuestion("What were your responsibilities in that project?"), true);
  assert.equal(isProjectExperienceQuestion("And what about your projects?"), true);
});

test("CIE routes Parakeet profile and cloud-service experience asks as contextual", () => {
  assert.equal(
    classifyComplexity("Can you walk me through your profile, explain your experience and skill set?"),
    "simple_contextual",
  );
  assert.equal(
    classifyComplexity("Azure and AWS services you worked on and how deep you used Data Factory?"),
    "simple_contextual",
  );
  assert.equal(
    classifyComplexity("Any critical situation you faced and how did you handle it?"),
    "simple_contextual",
  );
  assert.equal(
    classifyComplexity("How do you manage and secure sensitive credentials like client IDs and secrets in Azure and AWS?"),
    "simple_contextual",
  );
  assert.equal(
    classifyComplexity("How confident are you dealing with data using numpy and pandas?"),
    "simple_contextual",
  );
  assert.equal(
    classifyComplexity("What is your education?"),
    "simple_contextual",
  );
});

test("CIE does not treat Spark concepts and architecture as project/scenario by keyword alone", () => {
  assert.equal(classifyComplexity("Can you explain Spark architecture?"), "system_design");
  assert.equal(isProjectExperienceQuestion("Can you explain Spark architecture?"), false);
  assert.equal(classifyComplexity("What is data skew and how do you overcome it in Spark?"), "simple_atomic");
  assert.equal(detectFollowupIntent("What is data skew and how do you overcome it in Spark?"), false);
  assert.equal(
    classifyComplexity("Can we edit the broadcast join size limit in Spark and what are the challenges of increasing it to 250MB?"),
    "simple_atomic",
  );
  assert.equal(
    detectFollowupIntent("Can we edit the broadcast join size limit in Spark and what are the challenges of increasing it to 250MB?"),
    false,
  );
});

test("CIE enables resume-backed project fallback when no AI projects are selected", () => {
  assert.equal(
    shouldUseResumeBackedProjectFallback({
      hasSelectedProjects: false,
      isProjectQuestion: true,
      isProjectDetailQuestion: false,
      isProjectOverview: false,
      isMixedExperienceProject: false,
      hasResume: true,
    }),
    true,
  );
  assert.equal(
    shouldUseResumeBackedProjectFallback({
      hasSelectedProjects: true,
      isProjectQuestion: true,
      isProjectDetailQuestion: true,
      isProjectOverview: true,
      isMixedExperienceProject: true,
      hasResume: true,
    }),
    false,
  );
});

test("CIE selected-project unresolved guard prevents resume or generic project substitution", () => {
  const context = buildSelectedProjectsUnavailableContext({
    selectedProjectIds: ["selected-primary", "selected-secondary"],
    resolvedProjectIds: ["selected-primary"],
  });

  assert.ok(context.includes("SELECTED_PROJECT_CONTEXT_UNAVAILABLE"));
  assert.ok(context.includes("Unresolved selected project IDs: selected-secondary"));
  assert.ok(context.includes("Do not invent project names"));
  assert.equal(context.includes("RESUME-BACKED PROJECT/WORK CONTEXT"), false);
});

test("CIE extracts full candidate profile sections for profile walkthrough questions", () => {
  const context = extractCandidateProfileContext({
    resumeText: [
      "Name: Tushar Vaghela",
      "Role: Backend Engineer",
      "Summary",
      "Backend engineer with 2 years of experience building APIs and secure systems.",
      "Work Experience",
      "WebSenor | MERN Stack Developer | Nov 2024 - Feb 2025",
      "- Built backend APIs and React dashboards.",
      "MyPay Communication | React Developer | Mar 2025 - Present",
      "- Worked on frontend integrations.",
      "Skills",
      "Languages: JavaScript, TypeScript",
      "Frameworks: Node.js, NestJS, React",
      "Databases: MongoDB, Redis",
      "Projects",
      "Resume-only Project",
      "- This should be optional based on selected project mode.",
      "Education",
      "B.E. Computer Engineering",
      "Mumbai University",
      "Certifications",
      "AWS Cloud Practitioner | AWS | 2025",
    ].join("\n"),
    targetBudget: 800,
    includeResumeProjects: true,
  });

  assert.ok(context.includes("VERIFIED_CANDIDATE_PROFILE"));
  assert.ok(context.includes("Name: Tushar Vaghela"));
  assert.ok(context.includes("Total Experience: 2 years of experience"));
  assert.ok(context.includes("WebSenor"));
  assert.ok(context.includes("MyPay Communication"));
  assert.ok(context.includes("B.E. Computer Engineering"));
  assert.ok(context.includes("AWS Cloud Practitioner"));
  assert.ok(context.includes("Resume Project Summary"));
});

test("CIE derives factual total experience from dated work history", () => {
  const context = extractCandidateProfileContext({
    resumeText: [
      "TUSHAR VAGHELA",
      "R E A C T D E V E L O P E R",
      "T E C H N I C A L S K I L L S",
      "JavaScript, ReactJS, Node.js, MongoDB",
      "W O R K E X P E R I E N C E",
      "WebSenor Full Stack Developer Intern Aug 2024 – Oct 2024",
      "WebSenor MERN Stack Developer Nov 2024 – Feb 2025",
      "MyPay Communication React Developer Feb 2025 – Present",
      "E D U C A T I O N",
      "Bachelor of Computer Applications Oct 2021 - Oct 2024",
    ].join("\n"),
    targetBudget: 400,
    includeResumeProjects: false,
    currentDate: new Date("2026-06-07T00:00:00.000Z"),
    query: "What is your educational background and skill set?",
  });

  assert.ok(context.includes("Total Experience: 1 year 11 months"));
  assert.ok(context.includes("Education:"));
  assert.ok(context.includes("Bachelor of Computer Applications"));
  assert.ok(context.includes("Skills:"));
  assert.ok(context.includes("JavaScript, ReactJS, Node.js, MongoDB"));
});

test("CIE reads identity and education from a reverse-column resume extraction", () => {
  const context = extractCandidateProfileContext({
    resumeText: [
      "Innovative Data Engineer with over 5.9 years of experience specializing in data architecture and engineering.",
      "About Me",
      "Work Experience",
      "April 2023 - present",
      "Data Engineer",
      "3i Infotech LTD.",
      "PROJECT ENGINEER",
      "NOV 2018 - OCT 2021",
      "WIPRO LIMITED",
      "Data Engineer",
      "DHIRAJ",
      "THAKUR",
      "thakurdhiraj10@gmail.com",
      "+91 8268982898",
      "Mumbai, India",
      "Skills",
      "Contact",
      "Language",
      "B.E/B.Tech",
      "SIES Graduate School of",
      "Technology, Mumbai",
      "University",
      "2014 - 2018",
      "Education",
      "Databricks",
      "PySpark",
      "Python",
      "SQL Azure",
      "Redshift",
      "AWS Glue",
      "Athena",
      "Lambda",
      "English",
      "Hindi",
    ].join("\n"),
    targetBudget: 500,
    includeResumeProjects: false,
    query: "What is your educational background?",
  });

  assert.ok(context.includes("Name: Dhiraj Thakur"));
  assert.ok(context.includes("B.E/B.Tech"));
  assert.ok(context.includes("SIES Graduate School of"));
  assert.ok(context.includes("2014 - 2018"));
  assert.equal(context.includes("Education:\nEducation\nDatabricks"), false);
});

test("CIE profile digest excludes resume project section when selected projects are active", () => {
  const context = extractCandidateProfileContext({
    resumeText: [
      "Name: Tushar Vaghela",
      "Role: Backend Engineer",
      "Work Experience",
      "WebSenor | MERN Stack Developer | Nov 2024 - Feb 2025",
      "- Built backend APIs.",
      "Projects",
      "Resume-only Generic Banking Platform",
      "- Should not appear when selected AI project context is active.",
      "Education",
      "B.E. Computer Engineering",
    ].join("\n"),
    targetBudget: 700,
    includeResumeProjects: false,
  });

  assert.ok(context.includes("WebSenor"));
  assert.ok(context.includes("B.E. Computer Engineering"));
  assert.equal(context.includes("Resume-only Generic Banking Platform"), false);
  assert.equal(context.includes("Resume Project Summary"), false);
});

test("CIE separates intro background from explicit project detail", () => {
  assert.equal(
    isExplicitProjectDetailQuestion("Introduce yourself and explain the progress/work you have done."),
    false,
  );
  assert.equal(
    isExplicitProjectDetailQuestion("Explain your project architecture and tech stack."),
    true,
  );
});

test("CIE project context places PRIMARY project first for overview asks", () => {
  const projectRecords = [
    {
      id: "optional-1",
      projects: [{ projectHeader: { title: "Optional Payments Engine", role: "Backend Engineer" }, sections: [] }],
    },
    {
      id: "primary-1",
      projects: [{ projectHeader: { title: "Primary Finance Platform", role: "Tech Lead" }, sections: [] }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Tell me about your projects",
    700,
    { selectedProjectIds: ["primary-1", "optional-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("PRIMARY PROJECT: Primary Finance Platform"));
  assert.ok(context.indexOf("PRIMARY PROJECT: Primary Finance Platform") < context.indexOf("OPTIONAL PROJECT: Optional Payments Engine"));
});

test("CIE project context still allows optional project to lead when explicitly asked", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{ projectHeader: { title: "Primary Finance Platform", role: "Tech Lead" }, sections: [] }],
    },
    {
      id: "optional-1",
      projects: [{ projectHeader: { title: "Optional Logistics Tool", role: "Backend Engineer" }, sections: [] }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain Optional Logistics Tool project",
    700,
    { selectedProjectIds: ["primary-1", "optional-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("PRIMARY PROJECT: Primary Finance Platform"));
  assert.ok(context.includes("OPTIONAL PROJECT: Optional Logistics Tool"));
  assert.ok(context.indexOf("OPTIONAL PROJECT: Optional Logistics Tool") < context.indexOf("PRIMARY PROJECT: Primary Finance Platform"));
});

test("CIE project context includes concise architecture and flow details when available", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Payments Core", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          { key: "architecture_diagram", type: "code_block", content: "Client -> API Gateway -> Payments Service -> Postgres" },
          {
            key: "data_flow",
            type: "steps",
            content: [
              { step: "Capture request", description: "Receive payment" },
              { step: "Validate", description: "Fraud and schema checks" },
              { step: "Persist", description: "Store transaction" },
            ],
          },
          {
            key: "challenges_resolution",
            type: "challenge_cards",
            content: [{ challenge: "Duplicate webhook retries", solution: "Idempotency keys + dedupe table" }],
          },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain your project architecture",
    900,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(
    context.includes("[Architecture]:") ||
      context.includes("[Architecture Diagram]:"),
  );
  assert.ok(context.includes("[Flow]:"));
  assert.ok(context.includes("[Challenge]:"));
});

test("CIE project context preserves architecture diagram markdown block", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Banking Gateway", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          {
            key: "architecture_diagram",
            title: "Architecture Diagram",
            type: "code_block",
            content: "Web -> API Gateway -> Service\nService -> Redis\nService -> Postgres",
          },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "explain your project",
    1000,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("[Architecture Diagram]:"));
  assert.ok(context.includes("```text"));
  assert.ok(context.includes("Web -> API Gateway -> Service"));
});

test("CIE extracts project/work context from selected resume for project asks", () => {
  const context = extractResumeProjectContext(
    [
      "SUMMARY",
      "Data engineer with Azure experience.",
      "SKILLS",
      "Python Azure Databricks",
      "PROJECTS",
      "Hilton Grand Vacations",
      "438 Days",
      "- Spearheading migration of legacy data pipelines to cloud-based architecture using Databricks and Azure.",
      "- Managing high-volume data processing and governance policies.",
      "INFY",
      "366 Days",
      "- Developed a secure and scalable Data Lake to improve data accessibility.",
      "- Focused on large-scale data integration and automation.",
      "EDUCATION",
      "Bachelor of Engineering",
    ].join("\n"),
    "Explain my projects",
    900,
  );

  assert.ok(context.includes("RESUME-BACKED PROJECT/WORK CONTEXT"));
  assert.ok(context.includes("Hilton Grand Vacations"));
  assert.ok(context.includes("INFY"));
  assert.ok(context.includes("Databricks and Azure"));
});

test("CIE keeps architecture diagram block even under tighter project token budget", () => {
  const projectRecords = [
    {
      id: "primary-1",
      projects: [{
        projectHeader: { title: "Payments Core", role: "Backend Engineer", domain: "Fintech" },
        sections: [
          { key: "resume_ready_bullets", type: "bullets", content: ["A", "B", "C", "D", "E"] },
          { key: "introduction", type: "narrative", content: "Long intro ".repeat(60) },
          {
            key: "architecture_diagram",
            title: "Architecture Diagram",
            type: "code_block",
            content: "Client -> API -> Service\nService -> Redis\nService -> Postgres",
          },
          { key: "business_purpose", type: "narrative", content: "Purpose ".repeat(80) },
        ],
      }],
    },
  ];

  const context = extractRelevantProjectContext(
    projectRecords,
    "Explain your project",
    350,
    { selectedProjectIds: ["primary-1"], primaryProjectId: "primary-1" },
  );

  assert.ok(context.includes("[Architecture Diagram]:"));
  assert.ok(context.includes("```text"));
});
