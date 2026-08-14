import { EntryGate } from "@/components/EntryGate";
import { PortfolioApp } from "@/components/PortfolioApp";
import { loadPortfolioContent } from "@/lib/content";

export default function Home() {
  const content = loadPortfolioContent();
  return (
    <EntryGate>
      <PortfolioApp content={content} />
    </EntryGate>
  );
}
