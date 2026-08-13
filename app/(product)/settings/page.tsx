import { SetupForm } from "@/components/forms/setup-form";
import { ConfigSummary } from "@/components/dashboard/config-summary";
import { TelegramSettings } from "@/components/forms/telegram-settings";

export default function SettingsPage() {
  return (
    <main id="main-content" className="route-page">
      <div className="content-wrap">
        <header className="route-page__heading"><h1>Route settings</h1><p>Review the supported position, safe wallet and policy before revalidation. Changing an armed route requires live checks again.</p></header>
        <div className="setup-layout">
          <SetupForm settings />
          <ConfigSummary />
        </div>
        <TelegramSettings />
      </div>
    </main>
  );
}
