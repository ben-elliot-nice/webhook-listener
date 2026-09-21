import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { ProjectDetail } from './pages/ProjectDetail'
import { SharedListener } from './pages/SharedListener'
import { SharedProject } from './pages/SharedProject'
import { SharedProjectListener } from './pages/SharedProjectListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/shared/:token" element={<SharedListener />} />
          <Route path="/shared/projects/:token" element={<SharedProject />} />
          <Route path="/shared/projects/:token/:listenerId" element={<SharedProjectListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
