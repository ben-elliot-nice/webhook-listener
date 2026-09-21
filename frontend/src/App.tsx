import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/AppLayout'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { ProjectDetail } from './pages/ProjectDetail'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
          <Route path="/listener/:id" element={<Listener />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/shared/:token" element={<SharedListener />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
