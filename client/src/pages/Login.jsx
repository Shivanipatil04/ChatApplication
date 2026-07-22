import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../config/api'
// E2EE integration point
import { ensureIdentityKeyPair, clearPeerKeyCache } from '../crypto/keyManager'
import './Auth.css'

// Eye icon components — inline SVG, no extra dependency
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

const Login = () => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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
      // E2EE integration point — generate/upload identity key pair on first login for this device
      clearPeerKeyCache()
      await ensureIdentityKeyPair(data.token)
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
            <div className="auth-password-wrap">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
  const [step, setStep] = useState(1)
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
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
              <div className="auth-password-wrap">
                <input
                  type={showNew ? 'text' : 'password'}
                  placeholder="Min. 6 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
                <button type="button" className="auth-eye-btn" onClick={() => setShowNew((v) => !v)} aria-label={showNew ? 'Hide' : 'Show'}>
                  {showNew ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>
            <div className="auth-field">
              <label>Confirm password</label>
              <div className="auth-password-wrap">
                <input
                  type={showConfirm ? 'text' : 'password'}
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                <button type="button" className="auth-eye-btn" onClick={() => setShowConfirm((v) => !v)} aria-label={showConfirm ? 'Hide' : 'Show'}>
                  {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
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
