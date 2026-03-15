import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@infracode/ui";

interface StatCardProps {
  label: string;
  value: string;
  hint: string;
  tone?: "light" | "dark";
}

export const StatCard = ({ hint, label, tone = "light", value }: StatCardProps) => (
  <Card className={`${tone === "dark" ? "surface-card-dark metric-tile metric-tile-dark text-white" : "surface-card metric-tile"}`}>
    <CardHeader className={tone === "dark" ? "border-b border-white/8" : ""}>
      <CardDescription
        className={`font-[var(--font-mono)] uppercase tracking-[0.24em] ${tone === "dark" ? "text-slate-400" : "text-slate-500"}`}
      >
        {label}
      </CardDescription>
      <CardTitle className={`mt-2 text-4xl font-semibold ${tone === "dark" ? "text-white" : "text-slate-950"}`}>{value}</CardTitle>
    </CardHeader>
    <CardContent className={`pt-0 text-sm leading-6 ${tone === "dark" ? "text-slate-300" : "text-slate-600"}`}>{hint}</CardContent>
  </Card>
);
