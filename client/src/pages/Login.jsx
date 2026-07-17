import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../config/api'

const Login = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleLogin = async (event) => {
    event.preventDefault()
    setError('')
    try {
      const { data } = await api.post('/api/auth/login', { email, password })
      localStorage.setItem('chatToken', data.token)
      localStorage.setItem('chatUser', JSON.stringify(data.user))
      navigate('/chat')
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to log in. Please try again.')
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
          {error && <p className="auth-message">{error}</p>}
          <p className="auth-link">Don't have an account? <Link to="/register">Register here</Link></p>
        </form>
      </div>
    </div>
  )
}

export default Login
