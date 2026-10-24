import { useStore } from './store'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { MainArea } from './components/MainArea'
import { RightPanel } from './components/RightPanel'
import { DropOverlay } from './components/DropOverlay'
import { CommandPalette } from './components/CommandPalette'
import { NewSessionDialog } from './components/NewSessionDialog'
import { SettingsModal } from './components/SettingsModal'
import { GoalDialog, FleetDialog, BroadcastDialog } from './components/Dialogs'
import { AutomationDialog } from './components/Automations'
import { JobDesigner, JobRunDialog } from './components/Jobs'
import { RoutineRunDialog } from './components/Routines'
import { RepoDiffDialog } from './components/RepoManager'
import { ProcessAlerts } from './components/Actions'
import { MenuHost, PromptDialog, Toasts } from './components/ui'

export function App() {
  const popout = useStore((s) => s.popoutSessionId)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const right = useStore((s) => s.rightPanel)
  return (
    <div className="app">
      <TitleBar />
      <div className="body">
        {!popout && <Sidebar open={sidebarOpen} />}
        <MainArea />
        {right && <RightPanel panel={right} />}
      </div>
      {!popout && <DropOverlay />}
      <CommandPalette />
      <NewSessionDialog />
      <SettingsModal />
      <GoalDialog />
      <FleetDialog />
      <BroadcastDialog />
      <AutomationDialog />
      <JobDesigner />
      <JobRunDialog />
      <JobDesigner scope="routine" />
      <RoutineRunDialog />
      <RepoDiffDialog />
      <PromptDialog />
      <MenuHost />
      <Toasts>{!popout && <ProcessAlerts />}</Toasts>
    </div>
  )
}
