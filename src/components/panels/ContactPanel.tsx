"use client";

import { useState, type FormEvent } from "react";

type ContactPanelProps = {
  contactEmail: string;
};

export function ContactPanel({ contactEmail }: ContactPanelProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const subject = encodeURIComponent(`Portfolio contact from ${name || "visitor"}`);
    const body = encodeURIComponent(
      [`Name: ${name}`, `Email: ${email}`, "", message].join("\n"),
    );
    window.location.href = `mailto:${contactEmail}?subject=${subject}&body=${body}`;
  };

  return (
    <div
      data-panel-scroll="true"
      className="h-full overflow-y-auto overscroll-contain px-6 pt-24 pb-16"
    >
      <div className="mx-auto max-w-lg">
        <h2 className="font-display text-3xl tracking-tight sm:text-4xl">
          Contact
        </h2>
        <p className="mt-2 text-[var(--muted)]">
          Sends via your mail client to {contactEmail}.
        </p>

        <form onSubmit={onSubmit} className="mt-10 space-y-6">
          <label className="block">
            <span className="mb-2 block text-xs tracking-wide text-[var(--muted)] uppercase">
              Name
            </span>
            <input
              required
              name="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border-b border-[var(--border)] bg-transparent px-0 py-2 text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs tracking-wide text-[var(--muted)] uppercase">
              Email
            </span>
            <input
              required
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border-b border-[var(--border)] bg-transparent px-0 py-2 text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs tracking-wide text-[var(--muted)] uppercase">
              Message
            </span>
            <textarea
              required
              name="message"
              rows={5}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full resize-y border-b border-[var(--border)] bg-transparent px-0 py-2 text-[var(--text)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </label>
          <button
            type="submit"
            className="mt-4 border border-[var(--border)] px-5 py-2.5 text-sm tracking-wide text-[var(--text)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Open mail draft
          </button>
        </form>
      </div>
    </div>
  );
}
