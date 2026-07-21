import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../config/api'
import './Auth.css'

const Login = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showForgot, setShowForgot] = useState(false)
  const navigate = useNavigate()

  const handleLogin = async (event) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      const { data } = await api.post('/api/auth/login', { email, password, rememberMe })
      localStorage.setItem('chatToken', data.token)
      localStorage.setItem('chatUser', JSON.stringify(data.user))
      navigate('/chat')
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to log in. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (showForgot) return <ForgotPassword onBack={() => setShowForgot(false)} />

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">💬</div>
        <h1>Welcome Back</h1>
        <p className="auth-subtitle">Sign in to continue chatting</p>
        <form className="auth-form" onSubmit={handleLogin}>
          <div className="auth-field">
            <label>Email</label>
            <input
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="auth-field">
            <label>Password</label>
            <input
              type="password"
              placeholder="Enter password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="auth-row">
            <label className="auth-checkbox">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              <span>Remember me</span>
            </label>
            <button type="button" className="auth-link-btn" onClick={() => setShowForgot(true)}>
              Forgot password?
            </button>
          </div>
          <button className="auth-button" type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
          {error && <p className="auth-error">{error}</p>}
          <p className="auth-link">Don't have an account? <Link to="/register">Register here</Link></p>
        </form>
      </div>
    </div>
  )
}

// ---- Forgot Password Flow (inline 3-step) ----
const ForgotPassword = ({ onBack }) => {
  const [step, setStep] = useState(1) // 1=email, 2=otp, 3=reset
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const sendOtp = async (e) => {
    e.preventDefault()
    setError(''); setMessage(''); setLoading(true)
    try {
      const { data } = await api.post('/api/auth/forgot-password', { email })
      setMessage(data.message)
      setStep(2)
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send OTP.')
    } finally { setLoading(false) }
  }

  const verifyOtp = async (e) => {
    e.preventDefault()
    setError(''); setMessage(''); setLoading(true)
    try {
      const { data } = await api.post('/api/auth/verify-otp', { email, otp })
      setMessage(data.message)
      setStep(3)
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid OTP.')
    } finally { setLoading(false) }
  }

  const resetPassword = async (e) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }
    setError(''); setMessage(''); setLoading(true)
    try {
      const { data } = await api.post('/api/auth/reset-password', { email, otp, newPassword })
      setMessage(data.message + ' Redirecting…')
      setTimeout(onBack, 2000)
    } catch (err) {
      setError(err.response?.data?.message || 'Could not reset password.')
    } finally { setLoading(false) }
  }

  const stepTitles = ['Forgot Password', 'Enter OTP', 'New Password']
  const stepSubs = ['Enter your email and we\'ll send a 6-digit OTP.', `We sent a code to ${email}`, 'Choose a new password.']

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">🔑</div>
        <h1>{stepTitles[step - 1]}</h1>
        <p className="auth-subtitle">{stepSubs[step - 1]}</p>

        {step === 1 && (
          <form className="auth-form" onSubmit={sendOtp}>
            <div className="auth-field">
              <label>Email address</label>
              <input type="email" placeholder="your@email.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="auth-button" type="submit" disabled={loading}>{loading ? 'Sending…' : 'Send OTP'}</button>
          </form>
        )}

        {step === 2 && (
          <form className="auth-form" onSubmit={verifyOtp}>
            <div className="auth-field">
              <label>6-digit OTP</label>
              <input type="text" placeholder="123456" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value)} required />
            </div>
            <button className="auth-button" type="submit" disabled={loading}>{loading ? 'Verifying…' : 'Verify OTP'}</button>
            <button type="button" className="auth-link-btn" onClick={() => setStep(1)}>← Resend OTP</button>
          </form>
        )}

        {step === 3 && (
          <form className="auth-form" onSubmit={resetPassword}>
            <div className="auth-field">
              <label>New password</label>
              <input type="password" placeholder="Min. 6 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </div>
            <div className="auth-field">
              <label>Confirm password</label>
              <input type="password" placeholder="Repeat new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </div>
            <button className="auth-button" type="submit" disabled={loading}>{loading ? 'Resetting…' : 'Reset Password'}</button>
          </form>
        )}

        {message && <p className="auth-success">{message}</p>}
        {error && <p className="auth-error">{error}</p>}
        <button type="button" className="auth-link-btn" onClick={onBack} style={{ marginTop: 12 }}>← Back to login</button>
      </div>
    </div>
  )
}

export default Login
