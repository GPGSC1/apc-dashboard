"use client";

const C = {
  bg: "#06080F",
  card: "#0C0F1A",
  border: "#1B2440",
  accent: "#00D4B8",
  purple: "#6B2D99",
  orange: "#F37021",
  green: "#2D7A5F",
  text: "#E8E8F0",
  muted: "#6B7280",
};

const pages = [
  {
    title: "AI Voice Agent Dashboard",
    subtitle: "Campaign performance, list attribution, cost analysis",
    href: "/ai",
    color: C.accent,
    icon: "🤖",
  },
  {
    title: "Sales Dashboard",
    subtitle: "Closer performance, queue breakdowns, team metrics",
    href: "/sales",
    color: C.orange,
    icon: "📊",
  },
  {
    title: "AIDA",
    subtitle: "AI Dialer Automation — throttling, queue monitoring, campaign control",
    href: "/aida",
    color: C.purple,
    icon: "⚡",
  },
  {
    title: "CS Collections",
    subtitle: "PBS scrub lists, rep assignments, disposition tracking, performance",
    href: "/cs",
    color: "#14B8A6",
    icon: "📞",
  },
];

export default function HomePage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif",
        padding: 24,
      }}
    >
      <h1
        style={{
          color: C.text,
          fontSize: 32,
          fontWeight: 800,
          marginBottom: 4,
          letterSpacing: "-0.5px",
        }}
      >
        Guardian Protection Group
      </h1>
      <p style={{ color: C.muted, fontSize: 14, marginBottom: 48 }}>
        Select a dashboard
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: 20,
          maxWidth: 1000,
          width: "100%",
        }}
      >
        {pages.map((p) => (
          <a
            key={p.href}
            href={p.href}
            style={{
              background: C.card,
              border: `1px solid ${C.border}`,
              borderLeft: `4px solid ${p.color}`,
              borderRadius: 12,
              padding: "28px 24px",
              textDecoration: "none",
              transition: "all 0.2s ease",
              cursor: "pointer",
              display: "block",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = p.color;
              (e.currentTarget as HTMLElement).style.transform = "translateY(-2px)";
              (e.currentTarget as HTMLElement).style.boxShadow = `0 8px 24px ${p.color}22`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.borderColor = C.border;
              (e.currentTarget as HTMLElement).style.borderLeftColor = p.color;
              (e.currentTarget as HTMLElement).style.transform = "none";
              (e.currentTarget as HTMLElement).style.boxShadow = "none";
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 12 }}>{p.icon}</div>
            <div
              style={{
                color: p.color,
                fontSize: 18,
                fontWeight: 700,
                marginBottom: 6,
              }}
            >
              {p.title}
            </div>
            <div style={{ color: C.muted, fontSize: 13, lineHeight: 1.5 }}>
              {p.subtitle}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
