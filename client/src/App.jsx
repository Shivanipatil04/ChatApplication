import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import ChatApp from './pages/ChatApp'
import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'

const ProtectedRoute = ({ children }) => (
  localStorage.getItem('chatToken') ? children : <Navigate to="/login" replace />
)

const App = () => {
  return (
    <BrowserRouter>
      <Navbar />
      <div>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/chat" element={<ProtectedRoute><ChatApp /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
