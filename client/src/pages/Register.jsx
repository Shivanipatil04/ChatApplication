import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../config/api'
import './Auth.css'

const Register = () => {
  const [user, setUser] = useState({ name: '', email: '', password: '' })
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
            <input type="password" name="password" placeholder="Min. 6 characters" value={user.password} onChange={handleChange} required />
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
