import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../config/api'
import './Auth.css'

const EyeIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
)

const EyeOffIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
)

const Register = () => {
  const [user, setUser] = useState({ name: '', email: '', password: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true); setError('')
    try {
      await api.post('/api/auth/register', user)
      navigate('/login')
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to create account. Please try again.')
    } finally { setLoading(false) }
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    setUser((prev) => ({ ...prev, [name]: value }))
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">✨</div>
        <h1>Create Account</h1>
        <p className="auth-subtitle">Join and start connecting</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>Full Name</label>
            <input type="text" name="name" placeholder="Your name" value={user.name} onChange={handleChange} required />
          </div>
          <div className="auth-field">
            <label>Email</label>
            <input type="email" name="email" placeholder="your@email.com" value={user.email} onChange={handleChange} required />
          </div>
          <div className="auth-field">
            <label>Password</label>
            <div className="auth-password-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                name="password"
                placeholder="Min. 6 characters"
                value={user.password}
                onChange={handleChange}
                required
              />
              <button
                type="button"
                className="auth-eye-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
          <button className="auth-button" type="submit" disabled={loading}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
          {error && <p className="auth-error">{error}</p>}
          <p className="auth-link">Already have an account? <Link to="/login">Login here</Link></p>
        </form>
      </div>
    </div>
  )
}

export default Register
