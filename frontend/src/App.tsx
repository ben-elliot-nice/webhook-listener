import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Home } from './pages/Home'
import { Listener } from './pages/Listener'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/listener/:id" element={<Listener />} />
      </Routes>
    </BrowserRouter>
  )
}
