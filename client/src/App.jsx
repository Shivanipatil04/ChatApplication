import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Navbar from './components/Navbar'
import ChatApp from './pages/ChatApp'
import Login from './pages/Login'
import Register from './pages/Register'

const App = () => {
  return (
    <BrowserRouter>
    <Navbar />
      <div>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/chat" element={<ChatApp />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

export default App