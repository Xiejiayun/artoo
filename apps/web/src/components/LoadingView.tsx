import { Skeleton, SkeletonText } from "../ui/index.js";
import "./loading-view.css";

type LoadingShape = "list" | "detail" | "form" | "page" | "goals" | "release";

function Rows({ className = "" }: { className?: string }): React.ReactNode {
  return <div className={`loading-view__rows ${className}`}>{[0, 1, 2].map(row =>
    <div className="loading-view__row" key={row}><Skeleton width="75%" height={16} /><SkeletonText lines={2} /></div>,
  )}</div>;
}

function Cards(): React.ReactNode {
  return <div className="loading-view__cards">{[0, 1].map(card =>
    <div className="loading-view__card" key={card}><Skeleton width="55%" height={24} /><SkeletonText lines={3} /></div>,
  )}</div>;
}

/** Decorative placeholders share one status; they never imitate interactive controls or evidence. */
export function LoadingView({ label, shape = "detail" }: { label: string; shape?: LoadingShape }): React.ReactNode {
  return <div className={`loading-view loading-view--${shape}`} role="status">
    <span className="loading-view__label">{label}</span>
    <div aria-hidden="true" inert>
      {shape === "goals" || shape === "release" ? <div className={shape === "goals" ? "insights-goal-layout" : "os-release-layout"}>
        <Rows className={shape === "goals" ? "insights-goal-picker" : "os-release-goals"} /><Cards />
      </div> : shape === "list" ? <Rows /> : shape === "form" ? <div className="loading-view__form">
        {[0, 1].map(field => <div key={field}><Skeleton width="35%" height={12} /><Skeleton width="100%" height={36} /></div>)}
        <Skeleton width={112} height={36} />
      </div> : <>{shape === "page" && <Skeleton width="35%" height={32} />}<Cards /></>}
    </div>
  </div>;
}
