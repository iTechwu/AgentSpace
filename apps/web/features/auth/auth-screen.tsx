"use client";

import Image from "next/image";
import { useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { translateAuthError } from "./auth-error-messages";

type ProductTour = {
  id: "messages" | "employees" | "runtime" | "skills";
  index: string;
  label: string;
  title: string;
  description: string;
  imageSrc: string;
  imageAlt: string;
  proof: string;
};

type WorkStep = {
  icon: AppIconName;
  index: string;
  title: string;
  description: string;
};

type EWord = {
  word: string;
  label: string;
  desc: string;
};

export function AuthScreen({
  ssoStartUrl: externalSsoStartUrl,
  initialError,
}: {
  ssoStartUrl?: string;
  initialError?: string;
}) {
  const { language, setLanguage, tx } = useLanguage();
  const [activeTourId, setActiveTourId] = useState<ProductTour["id"]>("messages");
  const tours = buildProductTours(tx);
  const activeTour = tours.find((tour) => tour.id === activeTourId) ?? tours[0];
  const ssoStartUrl = externalSsoStartUrl ?? "/api/auth/sso/start";
  const brandVision = process.env.NEXT_PUBLIC_BRAND_VISION?.trim() || tx(
    "Do For E —— 一份开放宣言。dofe 不只是一套 AI 系统：它是为员工、企业与赋能而生的执行引擎。",
    "Do For E — an open manifesto. dofe is more than an AI system: it's an execution engine built for Employees, Enterprises, and Empowerment.",
  );
  const brandMission = process.env.NEXT_PUBLIC_BRAND_MISSION?.trim() || tx(
    "像海豚一样温暖，像钢铁一样可靠。连接孤岛，构建智能生态，让每一次执行都走向卓越。",
    "Warm like a dolphin, reliable as iron. We connect silos, build intelligent ecosystems, and make every execution a step toward excellence.",
  );
  const primaryEntryLabel = tx("使用 Dofe SSO 登录", "Continue with Dofe SSO");
  const eWords = buildEWords(tx);

  return (
    <main className="public-home" id="home">
      <header className="public-header">
        <a className="public-brand" href="#home" aria-label={tx("返回 agent.dofe 首页", "Back to agent.dofe home")}>
          <span className="public-brand__mark" aria-hidden="true">d</span>
          <span>DoFe.AI</span>
        </a>

        <nav className="public-header__nav" aria-label={tx("首页导航", "Homepage navigation")}>
          <a href="#product">{tx("产品", "Product")}</a>
          <a href="#workflow">{tx("工作方式", "How it works")}</a>
          <a href="#roles">{tx("适用角色", "For teams")}</a>
          <a href="#values">{tx("价值坐标", "Values")}</a>
          <a href="#brand">{tx("关于 dofe", "About dofe")}</a>
        </nav>

        <div className="public-header__actions">
          <div className="public-language" aria-label={tx("切换语言", "Switch language")} role="group">
            <button
              aria-pressed={language === "zh"}
              className={language === "zh" ? "is-active" : undefined}
              onClick={() => setLanguage("zh")}
              type="button"
            >
              中
            </button>
            <button
              aria-pressed={language === "en"}
              className={language === "en" ? "is-active" : undefined}
              onClick={() => setLanguage("en")}
              type="button"
            >
              EN
            </button>
          </div>
          <a className="public-button public-button--compact" href={ssoStartUrl}>
            {tx("登录", "Sign in")}
            <AppIcon name="arrowRight" />
          </a>
        </div>
      </header>

      <section className="public-hero" aria-labelledby="public-hero-title">
        <div className="public-hero__inner">
          <div className="public-hero__copy">
            <p className="public-eyebrow">Do For Employee · Do For Enterprise · Do For Empowerment</p>
            <h1 id="public-hero-title">agent.dofe</h1>
            <p className="public-hero__statement">
              {language === "zh" ? (
                <><span className="public-nowrap">人类与数字员工</span>，共用一个工作空间。</>
              ) : (
                "One workspace for people and digital employees."
              )}
            </p>
            <p className="public-hero__lead">
              {tx(
                "Do For E 是一套面向员工、企业与赋能的执行引擎：从一句话发起工作，让AI员工接力执行，人类在关键节点做决定。",
                "Do For E is an execution engine for employees, enterprises, and empowerment: start with one request, let AI employees carry the work forward, and keep people in control of critical decisions.",
              )}
            </p>
            <div className="public-signin" aria-labelledby="public-signin-title">
              <div>
                <p className="public-signin__eyebrow">DoFe.AI</p>
                <h2 id="public-signin-title">{tx("登录 DoFe.AI", "Sign in to DoFe.AI")}</h2>
                <p>{tx("选择登录方式，进入你的工作空间。", "Choose how to sign in")}</p>
              </div>
              <a className="public-button public-button--primary" href={ssoStartUrl}>
                {primaryEntryLabel}
                <AppIcon name="arrowRight" />
              </a>
            </div>
            <div className="public-hero__actions">
              <a className="public-button public-button--secondary" href="#product">
                {tx("查看真实产品", "Explore the product")}
                <AppIcon name="chevronDown" />
              </a>
            </div>
            {initialError ? (
              <p className="public-feedback" role="alert">{translateAuthError(initialError, tx)}</p>
            ) : null}
          </div>

          <div className="public-hero__product">
            <div className="public-product-label">
              <span><i aria-hidden="true" />{tx("当前产品界面", "Live product interface")}</span>
              <span>{tx("协作工作区", "Collaboration workspace")}</span>
            </div>
            <div className="public-product-shot public-product-shot--hero">
              <Image
                alt={tx("agent.dofe 消息协作工作区", "agent.dofe messaging workspace")}
                height={720}
                loading="eager"
                priority
                src="/product/workspace-messages.png"
                width={1280}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="public-loop" aria-label={tx("工作闭环", "Work loop")}>
        <div className="public-loop__inner">
          {buildWorkSteps(tx).map((step) => (
            <article key={step.index}>
              <span className="public-loop__index">{step.index}</span>
              <AppIcon name={step.icon} />
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="public-section public-product" id="product" aria-labelledby="public-product-title">
        <div className="public-section__intro">
          <p className="public-eyebrow">{tx("真实产品导览", "Real product tour")}</p>
          <h2 id="public-product-title">
            {tx("不是另一个聊天框，而是一套可运行的工作系统。", "More than a chat box. A working operating system.")}
          </h2>
          <p>
            {tx(
              "以下界面均采集自当前登录工作区。每一处能力都对应一个清晰动作，并有明确的后续状态。",
              "Every screen below is captured from the current signed-in workspace. Each capability maps to a clear action and a visible next state.",
            )}
          </p>
        </div>

        <div className="public-tour">
          <div className="public-tour__tabs" role="tablist" aria-label={tx("产品页面", "Product screens")}>
            {tours.map((tour) => (
              <button
                aria-controls={`tour-panel-${tour.id}`}
                aria-selected={tour.id === activeTour.id}
                className={tour.id === activeTour.id ? "is-active" : undefined}
                id={`tour-tab-${tour.id}`}
                key={tour.id}
                onClick={() => setActiveTourId(tour.id)}
                role="tab"
                type="button"
              >
                <span>{tour.index}</span>
                <strong>{tour.label}</strong>
              </button>
            ))}
          </div>

          <div
            aria-labelledby={`tour-tab-${activeTour.id}`}
            className="public-tour__panel"
            id={`tour-panel-${activeTour.id}`}
            key={activeTour.id}
            role="tabpanel"
          >
            <div className="public-tour__copy">
              <p className="public-eyebrow">{activeTour.proof}</p>
              <h3>{activeTour.title}</h3>
              <p>{activeTour.description}</p>
            </div>
            <div className="public-product-shot">
              <Image
                alt={activeTour.imageAlt}
                height={720}
                loading="eager"
                src={activeTour.imageSrc}
                width={1280}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="public-section public-workflow" id="workflow" aria-labelledby="public-workflow-title">
        <div className="public-section__intro public-section__intro--light">
          <p className="public-eyebrow">{tx("从意图到结果", "From intent to outcome")}</p>
          <h2 id="public-workflow-title">
            {tx("把协作、执行与治理放进同一个闭环。", "Put collaboration, execution, and governance in one loop.")}
          </h2>
        </div>
        <div className="public-workflow__track">
          {buildWorkflow(tx).map((item) => (
            <article key={item.index}>
              <span>{item.index}</span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="public-section public-roles" id="roles" aria-labelledby="public-roles-title">
        <div className="public-section__intro">
          <p className="public-eyebrow">{tx("同一个工作区，不同的清晰视角", "One workspace, clear views for every role")}</p>
          <h2 id="public-roles-title">
            {tx("员工专注完成工作，管理者关注进度，管理员守住边界。", "Employees deliver, managers coordinate, and admins protect the boundaries.")}
          </h2>
        </div>
        <div className="public-roles__grid">
          {buildRoleViews(tx).map((role) => (
            <article key={role.index}>
              <span>{role.index}</span>
              <p>{role.audience}</p>
              <h3>{role.title}</h3>
              <ul>
                {role.items.map((item) => <li key={item}><AppIcon name="checkCircle" />{item}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="public-section public-values" id="values" aria-labelledby="public-values-title">
        <div className="public-section__intro">
          <p className="public-eyebrow">{tx("Do For E 价值坐标", "The Do For E coordinates")}</p>
          <h2 id="public-values-title">
            {tx("从人的能力出发，把执行力扩展到整个组织。", "Start with human capability. Extend execution across the organization.")}
          </h2>
          <p>
            {tx(
              "9 个 E 词汇，组成 DoFe.AI 的产品判断：先让人被看见，再让企业变得更强，最终让每一次执行都趋向卓越。",
              "Nine E words define how DoFe.AI makes product decisions: keep people visible, make enterprises stronger, and move every execution toward excellence.",
            )}
          </p>
        </div>
        <div className="public-values__grid">
          {eWords.map((item) => (
            <article key={item.word} className="public-value-card">
              <span className="public-value-card__word">{item.word.slice(0, 1)}</span>
              <div>
                <p>{item.label}</p>
                <h3>{item.word}</h3>
                <span>{item.desc}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="public-brand-story" id="brand" aria-labelledby="public-brand-title">
        <div className="public-brand-story__inner">
          <div>
            <p className="public-eyebrow">{tx("品牌理念", "Brand idea")}</p>
            <h2 id="public-brand-title">Do For E</h2>
            <p className="public-brand-story__tagline">Do For Employee · Do For Enterprise · Do For Empowerment</p>
          </div>
          <div className="public-brand-story__promise">
            <article>
              <span>{tx("理念", "Philosophy")}</span>
              <strong>{brandVision}</strong>
            </article>
            <article>
              <span>{tx("承诺", "Commitment")}</span>
              <strong>{brandMission}</strong>
            </article>
            <article>
              <span>{tx("公开宣言", "Open manifesto")}</span>
              <strong>{tx(
                "Do For E —— 不只是一套 AI 系统，更是为员工、企业与赋能而生的执行引擎。",
                "Do For E — an open manifesto. More than an AI system: an execution engine built for Employees, Enterprises, and Empowerment.",
              )}</strong>
            </article>
            <p>
              {tx(
                "dofe 不只是一套 AI 系统，更是为员工、为企业、为赋能而生的执行力引擎。",
                "dofe is more than an AI system. It is an execution engine built for employees, enterprises, and empowerment.",
              )}
            </p>
          </div>
        </div>
      </section>

      <section className="public-final" aria-labelledby="public-final-title">
        <p className="public-eyebrow">agent.dofe</p>
        <h2 id="public-final-title">{tx("让每一次执行，都通向结果。", "Make every execution lead to an outcome.")}</h2>
        <p>{tx("连接团队与数字员工，从今天的真实工作开始。", "Connect your team and digital employees around real work today.")}</p>
          <a className="public-button public-button--primary" href={ssoStartUrl}>
          {tx("进入工作区", "Open workspace")}
          <AppIcon name="arrowRight" />
        </a>
      </section>

      <footer className="public-footer">
        <span>agent.dofe</span>
        <span>Do For Employee · Enterprise · Empowerment</span>
      </footer>
    </main>
  );
}

function buildWorkSteps(tx: (zh: string, en: string) => string): WorkStep[] {
  return [
    { icon: "messages", index: "01", title: tx("发起", "Request"), description: tx("在消息中说清目标", "State the outcome in a message") },
    { icon: "agents", index: "02", title: tx("协同", "Coordinate"), description: tx("数字员工自动接力", "Digital employees hand work off") },
    { icon: "approvals", index: "03", title: tx("把关", "Approve"), description: tx("关键动作由人确认", "People confirm critical actions") },
    { icon: "containers", index: "04", title: tx("执行", "Execute"), description: tx("Runtime 持续交付结果", "Runtimes keep delivery moving") },
  ];
}

function buildProductTours(tx: (zh: string, en: string) => string): ProductTour[] {
  return [
    {
      id: "messages",
      index: "01",
      label: tx("消息协作", "Messaging"),
      title: tx("从一句话开始，把工作交给正确的人或 AI员工。", "Start with one request and route it to the right person or AI employee."),
      description: tx("会话、数字联系人与后续任务保持联动；不可用能力明确禁用，可用操作都会进入下一步。", "Conversations, digital contacts, and downstream tasks stay connected. Unavailable actions are disabled; available actions always lead somewhere."),
      imageSrc: "/product/workspace-messages.png",
      imageAlt: tx("消息协作页面截图", "Messaging workspace screenshot"),
      proof: tx("发起与协作", "Request and collaborate"),
    },
    {
      id: "employees",
      index: "02",
      label: tx("数字员工", "Digital employees"),
      title: tx("把 AI员工 当作组织能力管理，而不是散落的工具。", "Manage AI employees as organizational capability, not scattered tools."),
      description: tx("统一查看数字员工的角色、可用状态、技能与知识，并决定由谁管理、在哪里调用。", "See each digital employee's role, availability, skills, and knowledge, then control who manages and uses it."),
      imageSrc: "/product/employee-showcase.png",
      imageAlt: tx("数字员工展板页面截图", "Digital employee directory screenshot"),
      proof: tx("发现与配置", "Discover and configure"),
    },
    {
      id: "runtime",
      index: "03",
      label: tx("执行引擎", "Execution engines"),
      title: tx("看得见每一个执行环境的状态、队列与归属。", "See the status, queue, and ownership of every execution environment."),
      description: tx("管理员可以接入服务器、更新 Runtime、查看心跳与运行统计；普通成员只看到与工作有关的能力。", "Admins can connect servers, update runtimes, and inspect heartbeats and run statistics while members see only what their work requires."),
      imageSrc: "/product/execution-engine.png",
      imageAlt: tx("执行引擎管理页面截图", "Execution engine management screenshot"),
      proof: tx("运行与治理", "Run and govern"),
    },
    {
      id: "skills",
      index: "04",
      label: tx("技能与知识", "Skills and knowledge"),
      title: tx("让能力可以复用、分配、更新，也可以被审计。", "Make capabilities reusable, assignable, updatable, and auditable."),
      description: tx("从系统技能、本地导入到团队知识，能力资源都在工作区内被组织，并与数字员工明确绑定。", "System skills, local imports, and team knowledge stay organized in the workspace and explicitly bound to digital employees."),
      imageSrc: "/product/skills-library.png",
      imageAlt: tx("技能库页面截图", "Skills library screenshot"),
      proof: tx("扩展与复用", "Extend and reuse"),
    },
  ];
}

function buildWorkflow(tx: (zh: string, en: string) => string) {
  return [
    { index: "01", title: tx("表达意图", "Express intent"), description: tx("在熟悉的会话中描述目标、上下文和交付标准。", "Describe the outcome, context, and delivery criteria in a familiar conversation.") },
    { index: "02", title: tx("组织接力", "Coordinate work"), description: tx("匹配数字员工、技能、知识与合适的执行引擎。", "Match digital employees with the right skills, knowledge, and execution engine.") },
    { index: "03", title: tx("人类决策", "Human decision"), description: tx("高风险动作进入审批，责任与变更保持可见。", "Route high-risk actions to approval with ownership and changes visible.") },
    { index: "04", title: tx("交付沉淀", "Deliver and learn"), description: tx("结果回到消息、任务与知识库，成为下一次执行的上下文。", "Return outcomes to messages, tasks, and knowledge as context for the next run.") },
  ];
}

function buildRoleViews(tx: (zh: string, en: string) => string) {
  return [
    {
      index: "01",
      audience: tx("员工视角", "Employee view"),
      title: tx("少切换，多完成", "Less switching, more delivery"),
      items: [tx("从会话直接发起工作", "Start work from a conversation"), tx("在同一处追踪进度与结果", "Track progress and outcomes in one place"), tx("按需调用团队数字员工", "Use team digital employees when needed")],
    },
    {
      index: "02",
      audience: tx("管理者视角", "Manager view"),
      title: tx("过程透明，关键可控", "Visible progress, controlled decisions"),
      items: [tx("集中查看任务与阻塞", "See tasks and blockers centrally"), tx("审批关键动作与知识变更", "Approve critical actions and knowledge changes"), tx("管理可借用的组织能力", "Manage reusable organizational capability")],
    },
    {
      index: "03",
      audience: tx("管理员视角", "Admin view"),
      title: tx("边界清楚，运行可靠", "Clear boundaries, reliable execution"),
      items: [tx("管理执行引擎与连接状态", "Manage execution engines and connections"), tx("控制权限、范围与工作区隔离", "Control permissions, scope, and isolation"), tx("保留审批与执行审计轨迹", "Preserve approval and execution audit trails")],
    },
  ];
}

function buildEWords(tx: (zh: string, en: string) => string): EWord[] {
  return [
    { word: "Employee", label: tx("为员工", "For Employees"), desc: tx("始终以人为先，赋能每一位团队成员", "Always for the people — empower every team member") },
    { word: "Enterprise", label: tx("为企业", "For Enterprise"), desc: tx("放眼全局，驱动规模化智能转型", "Think big — drive intelligent transformation at scale") },
    { word: "Empowerment", label: tx("为赋能", "For Empowerment"), desc: tx("超越工具，延展并放大人的能力", "Beyond tools — extend and amplify human capability") },
    { word: "Execution", label: tx("为执行", "For Execution"), desc: tx("一句话启动一切，把想法即时变成行动", "One prompt starts everything — turn ideas into action instantly") },
    { word: "Efficiency", label: tx("为效率", "For Efficiency"), desc: tx("收回每一分钟浪费，让团队吞吐最大化", "Reclaim every wasted minute — max out your throughput") },
    { word: "Excellence", label: tx("为卓越", "For Excellence"), desc: tx("不止于交付，AI 标准化执行持续追求质量", "Never just ship it — AI-standardized execution pursues quality") },
    { word: "Ecosystem", label: tx("为生态", "For Ecosystem"), desc: tx("打破信息孤岛，构建协同的数字神经系统", "Break down silos — build a collaborative digital nervous system") },
    { word: "Evolution", label: tx("为进化", "For Evolution"), desc: tx("点燃组织持续进化，为未来而设计", "Ignite continuous organizational evolution — future-ready by design") },
    { word: "Escort", label: tx("为护航", "For Escort"), desc: tx("守护每一笔交易与资产，全天候 AI 安全护航", "Guard every transaction and asset — your AI security escort around the clock") },
  ];
}
