interface InfraCodeMarkProps {
  subtitle?: string;
  tone?: "super" | "tenant";
  className?: string;
}

export const InfraCodeMark = ({ subtitle, tone = "tenant", className }: InfraCodeMarkProps) => (
  <div className={["brand-chip", className].filter(Boolean).join(" ")}>
    <div className="brand-mark">
      <span className="brand-mark__glyph">{tone === "super" ? "ADM" : "IC"}</span>
      <span className="brand-mark__text text-xl">
        <strong>Infra</strong>
        <strong>Code</strong>
      </span>
    </div>
    {subtitle ? <span className="brand-chip__subtitle">{subtitle}</span> : null}
  </div>
);
