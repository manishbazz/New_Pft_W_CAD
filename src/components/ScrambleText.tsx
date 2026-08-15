"use client";

import { useEffect, useState } from "react";
import { playScrambleSound } from "@/lib/uiSound";

type ScrambleTextProps = {
  text: string;
  className?: string;
  as?: keyof JSX.IntrinsicElements;
  duration?: number;
  delay?: number;
};

const CHARSET =
  "!@#$%^&*ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function getRandomChar(): string {
  return CHARSET[Math.floor(Math.random() * CHARSET.length)];
}

export function ScrambleText({
  text,
  className = "",
  as: Component = "div",
  duration = 600,
  delay = 0,
}: ScrambleTextProps) {
  const [displayText, setDisplayText] = useState(text);
  const [isScrambling, setIsScrambling] = useState(false);

  useEffect(() => {
    // Start animation after delay
    const delayTimer = setTimeout(() => {
      setIsScrambling(true);
      playScrambleSound();

      const startTime = Date.now();
      const frames: NodeJS.Timeout[] = [];

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // Calculate how many characters should be revealed
        const revealCount = Math.floor(progress * text.length);

        // Create new display text
        let newText = "";
        for (let i = 0; i < text.length; i++) {
          if (i < revealCount) {
            // Reveal actual character
            newText += text[i];
          } else {
            // Show random character
            newText += getRandomChar();
          }
        }

        setDisplayText(newText);

        if (progress < 1) {
          const frameId = requestAnimationFrame(animate);
          frames.push(frameId);
        } else {
          setDisplayText(text);
          setIsScrambling(false);
        }
      };

      animate();

      return () => {
        frames.forEach((frameId) => cancelAnimationFrame(frameId));
      };
    }, delay);

    return () => clearTimeout(delayTimer);
  }, [text, duration, delay]);

  return (
    <Component className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {displayText}
    </Component>
  );
}
