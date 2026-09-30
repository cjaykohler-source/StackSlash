import { AppHeader } from "../components/AppHeader";
import { RegimeBanner } from "../components/RegimeBanner";
import { TrackingPanel } from "../components/TrackingPanel";
import { TriggerFeed } from "../components/TriggerFeed";
import { TopMovers } from "../components/TopMovers";

export function Dashboard() {
  return (
    <div className="page">
      <AppHeader />
      <RegimeBanner />
      <TrackingPanel />
      <div className="dashboard-body">
        <main className="dashboard-main">
          <TriggerFeed mode="today" />
        </main>
        <TopMovers />
      </div>
    </div>
  );
}
