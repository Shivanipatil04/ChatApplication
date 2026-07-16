import {BrowserRouter, Navigate, Routes, Route} from 'react-router-dom'
import ChatApp from './pages/ChatApp'
import Login from './pages/Login'
import Register from './pages/Register'

const ProtectedRoute = ({ children }) => (
  localStorage.getItem('chatToken') ? children : <Navigate to="/login" replace />
)

const App = () => {
  return (
    <BrowserRouter>
      <div>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login/>} />
          <Route path="/register" element={<Register/>} />
          <Route path="/chat" element={<ProtectedRoute><ChatApp/></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App
