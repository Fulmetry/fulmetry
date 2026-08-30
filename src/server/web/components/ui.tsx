// SPDX-FileCopyrightText: 2026 Fulmetry contributors
// SPDX-License-Identifier: MIT
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 items-center justify-center gap-2 rounded-full px-3 text-sm font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-[#9cff57]/80 disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "border border-[#9cff57] bg-[#9cff57] text-[#0b0e0c] shadow-[0_8px_18px_rgba(156,255,87,.12)] hover:-translate-y-0.5 hover:bg-[#b9ff84]",
        secondary: "border border-white/15 bg-[#1b201d] text-white hover:border-[#9cff57]/50 hover:bg-[#232a26]",
        ghost: "text-[#c6ceca] hover:bg-white/[0.07] hover:text-white",
        danger: "bg-rose-500 text-white hover:bg-rose-400",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-xs",
        icon: "size-9 px-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <section data-fulmetry-card className={cn("rounded-[18px] border border-white/[0.12] bg-[#141816] shadow-[0_18px_40px_rgba(0,0,0,.24)]", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <header className={cn("flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "info"; className?: string }) {
  const tones = {
    neutral: "border-white/15 bg-white/[0.05] text-[#bac3be]",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    warning: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    danger: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    info: "border-[#31d7de]/35 bg-[#31d7de]/10 text-[#7aeaf0]",
  };
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide", tones[tone], className)}>{children}</span>;
}

export function EmptyState({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-[#1d1d1d] p-8 text-center">
    <div className="rounded-full border border-orange-400/40 bg-orange-400/10 p-3 text-orange-300">{icon}</div>
    <div><p className="font-medium text-slate-100">{title}</p><p className="mt-1 max-w-md text-sm text-slate-400">{description}</p></div>
  </div>;
}

export function JsonDetails({ value, label = "Structured data" }: { value: unknown; label?: string }) {
  return <details className="group rounded-xl border border-white/10 bg-[#191919]">
    <summary className="cursor-pointer select-none px-4 py-3 text-sm font-bold text-[#d7d0c7] marker:text-orange-400 group-open:border-b group-open:border-white/10">{label}</summary>
    <pre className="max-h-[32rem] overflow-auto p-4 text-xs leading-5 text-slate-400">{JSON.stringify(value, null, 2)}</pre>
  </details>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-800", className)} />;
}
