"use client";

import Image from "next/image";
import { useState } from "react";
import type { WorkspaceRole } from "@agent-space/db";
import { useLanguage } from "@/features/i18n/language-provider";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";
import { translateAuthError } from "./auth-error-messages";

type InvitationContext = {
  token: string;
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
};

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

export function AuthScreen({
  ssoStartUrl: externalSsoStartUrl,
  initialError,
  invitation,
}: {
  ssoStartUrl?: string;
  initialError?: string;
  invitation?: InvitationContext;
}) {
  const { language, setLanguage, tx } = useLanguage();
  const [activeTourId, setActiveTourId] = useState<ProductTour["id"]>("messages");
  const tours = buildProductTours(tx);
  const activeTour = tours.find((tour) => tour.id === activeTourId) ?? tours[0];
  const ssoStartUrl = externalSsoStartUrl ?? (invitation
    ? `/api/auth/sso/start?invitationToken=${encodeURIComponent(invitation.token)}`
    : "/api/auth/sso/start");
  const brandVision = process.env.NEXT_PUBLIC_BRAND_VISION?.trim() || tx(
    "成为受世界尊敬的中国企业",
    "Become a globally respected company from China",
  );
  const brandMission = process.env.NEXT_PUBLIC_BRAND_MISSION?.trim() || tx(
    "成就中国智造的全球竞争力",
    "Strengthen the global competitiveness of intelligent manufacturing from China",
  );
  const primaryEntryLabel = invitation
    ? tx("使用 Dofe SSO 进入工作区", "Open workspace with Dofe SSO")
    : tx("使用 Dofe SSO 登录", "Continue with Dofe SSO");

  return (
    <main className="public-home" id="home">
      <header className="public-header">
        <a className="public-brand" href="#home" aria-label={tx("返回 agent.dofe 首页", "Back to agent.dofe home")}>
          <span className="public-brand__mark" aria-hidden="true">d</span>
          <span>agent.dofe</span>
        </a>

        <nav className="public-header__nav" aria-label={tx("首页导航", "Homepage navigation")}>
          <a href="#product">{tx("产品", "Product")}</a>
          <a href="#workflow">{tx("工作方式", "How it works")}</a>
          <a href="#roles">{tx("适用角色", "For teams")}</a>
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
            {invitation ? tx("接受邀请", "Accept invite") : tx("登录", "Sign in")}
            <AppIcon name="arrowRight" />
          </a>
        </div>
      </header>

      <section className="public-hero" aria-labelledby="public-hero-title">
        <div className="public-hero__inner">
          <div className="public-hero__copy">
            <p className="public-eyebrow">Do For Employee · Enterprise · Empowerment</p>
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
                "从一句话发起工作，到 Agent 接力执行、关键节点审批与全过程审计。让团队不再切换工具，而是持续推进结果。",
                "Start with one request, then let agents execute, people approve critical steps, and the workspace preserve the full audit trail.",
              )}
            </p>
            <div className="public-hero__actions">
              <a className="public-button public-button--primary" href={ssoStartUrl}>
                {primaryEntryLabel}
                <AppIcon name="arrowRight" />
              </a>
              <a className="public-button public-button--secondary" href="#product">
                {tx("查看真实产品", "Explore the product")}
                <AppIcon name="chevronDown" />
              </a>
            </div>
            {initialError ? (
              <p className="public-feedback" role="alert">{translateAuthError(initialError, tx)}</p>
            ) : null}
            {invitation ? (
              <div className="public-invite" aria-label={tx("工作区邀请", "Workspace invitation")}>
                <span>{tx("工作区邀请", "Workspace invite")}</span>
                <strong>{invitation.workspaceName}</strong>
                <small>{invitation.email} · {invitation.role}</small>
              </div>
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

      <section className="public-brand-story" id="brand" aria-labelledby="public-brand-title">
        <div className="public-brand-story__inner">
          <div>
            <p className="public-eyebrow">{tx("品牌理念", "Brand idea")}</p>
            <h2 id="public-brand-title">Do For E</h2>
            <p className="public-brand-story__tagline">Do For Employee · Do For Enterprise · Do For Empowerment</p>
          </div>
          <div className="public-brand-story__promise">
            <article>
              <span>{tx("愿景", "Vision")}</span>
              <strong>{brandVision}</strong>
            </article>
            <article>
              <span>{tx("使命", "Mission")}</span>
              <strong>{brandMission}</strong>
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
          {invitation ? tx("接受邀请并进入", "Accept invite and continue") : tx("进入工作区", "Open workspace")}
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
      title: tx("从一句话开始，把工作交给正确的人或 Agent。", "Start with one request and route it to the right person or agent."),
      description: tx("会话、数字联系人与后续任务保持联动；不可用能力明确禁用，可用操作都会进入下一步。", "Conversations, digital contacts, and downstream tasks stay connected. Unavailable actions are disabled; available actions always lead somewhere."),
      imageSrc: "/product/workspace-messages.png",
      imageAlt: tx("消息协作页面截图", "Messaging workspace screenshot"),
      proof: tx("发起与协作", "Request and collaborate"),
    },
    {
      id: "employees",
      index: "02",
      label: tx("数字员工", "Digital employees"),
      title: tx("把 Agent 当作组织能力管理，而不是散落的工具。", "Manage agents as organizational capability, not scattered tools."),
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
