import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'
import { SharedListener } from './pages/SharedListener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/listener/:id" element={<Listener />} />
        <Route path="/shared/:token" element={<SharedListener />} />
      </Routes>
    </BrowserRouter>
  )
}
