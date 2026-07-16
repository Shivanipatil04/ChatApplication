import React, { useState } from 'react'
import axios from 'axios'
import { Link, useNavigate } from 'react-router-dom'

const Login = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState('')
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    try {
      const res = await axios.post('http://localhost:5000/api/login', { email, password })
      localStorage.setItem('isLoggedIn', 'true')
      setMsg(res.data.msg)
      navigate('/chat')
    } catch (err) {
      setMsg(err.response?.data?.msg || 'Login failed')
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Welcome Back</h1>
        <p className="auth-subtitle">Sign in to continue chatting</p>
        <form className="auth-form" onSubmit={handleLogin}>
          <input type="email" placeholder="Enter Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="Enter Password" value={password} onChange={(e) => setPassword(e.target.value)} />

          <button className="auth-button" type="submit">Login</button>
          {msg && <p className="auth-message">{msg}</p>}
          <p className="auth-link">Don't have an account? <Link to="/register">Register Here</Link></p>
        </form>
      </div>
    </div>
  )
}

export default Login
