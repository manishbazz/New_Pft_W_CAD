import { PortfolioApp } from "@/components/PortfolioApp";
import { loadPortfolioContent } from "@/lib/content";

export default function Home() {
  const content = loadPortfolioContent();
  return <PortfolioApp content={content} />;
}
