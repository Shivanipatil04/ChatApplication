import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../config/api'
import './Settings.css'

const Settings = () => {
  const navigate = useNavigate()
  const token = localStorage.getItem('chatToken')
  const authorization = { headers: { Authorization: `Bearer ${token}` } }
  const fileInputRef = useRef(null)

  const [activeTab, setActiveTab] = useState('profile')
  const [profile, setProfile] = useState({ name: '', username: '', email: '', phone: '', bio: '', avatar: '' })
  const [avatarPreview, setAvatarPreview] = useState('')
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')
  const [profileError, setProfileError] = useState('')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdLoading, setPwdLoading] = useState(false)
  const [pwdMsg, setPwdMsg] = useState('')
  const [pwdError, setPwdError] = useState('')

  useEffect(() => {
    if (!token) { navigate('/login'); return }
    api.get('/api/profile', authorization)
      .then(({ data }) => { setProfile(data); setAvatarPreview(data.avatar || '') })
      .catch(() => {})
  }, []) // eslint-disable-line

  const handleAvatarChange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) { setProfileError('Image must be under 2MB.'); return }
    const reader = new FileReader()
    reader.onload = () => { setAvatarPreview(reader.result); setProfile((p) => ({ ...p, avatar: reader.result })) }
    reader.readAsDataURL(file)
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    setProfileError(''); setProfileMsg(''); setProfileLoading(true)
    try {
      const { data } = await api.patch('/api/profile', { name: profile.name, bio: profile.bio, phone: profile.phone, avatar: profile.avatar }, authorization)
      setProfile(data)
      // Update cached user in localStorage
      const cached = JSON.parse(localStorage.getItem('chatUser') || '{}')
      localStorage.setItem('chatUser', JSON.stringify({ ...cached, name: data.name, avatar: data.avatar }))
      setProfileMsg('Profile updated successfully!')
    } catch (err) {
      setProfileError(err.response?.data?.message || 'Could not save profile.')
    } finally { setProfileLoading(false) }
  }

  const changePassword = async (e) => {
    e.preventDefault()
    if (newPassword !== confirmPassword) { setPwdError('Passwords do not match.'); return }
    setPwdError(''); setPwdMsg(''); setPwdLoading(true)
    try {
      const { data } = await api.post('/api/auth/change-password', { currentPassword, newPassword }, authorization)
      setPwdMsg(data.message)
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('')
    } catch (err) {
      setPwdError(err.response?.data?.message || 'Could not change password.')
    } finally { setPwdLoading(false) }
  }

  const tabs = [
    { id: 'profile', label: '👤 Profile' },
    { id: 'account', label: '🔒 Account' },
  ]

  return (
    <div className="settings-page">
      <div className="settings-card">
        <div className="settings-header">
          <button className="settings-back" onClick={() => navigate('/chat')}>← Back to Chat</button>
          <h1>Settings</h1>
        </div>

        <div className="settings-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`settings-tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'profile' && (
          <form className="settings-form" onSubmit={saveProfile}>
            {/* Avatar */}
            <div className="settings-avatar-section">
              <div className="settings-avatar" onClick={() => fileInputRef.current?.click()}>
                {avatarPreview
                  ? <img src={avatarPreview} alt="avatar" />
                  : <span>{profile.name?.charAt(0)?.toUpperCase() || '?'}</span>
                }
                <div className="settings-avatar-overlay">📷</div>
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarChange} />
              <div className="settings-avatar-hint">Click to change photo (max 2MB)</div>
            </div>

            <div className="settings-field">
              <label>Full Name</label>
              <input type="text" value={profile.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} maxLength={60} required />
            </div>
            <div className="settings-field">
              <label>Username</label>
              <input type="text" value={profile.username} disabled className="disabled" />
              <span className="settings-hint">Username cannot be changed</span>
            </div>
            <div className="settings-field">
              <label>Email</label>
              <input type="email" value={profile.email} disabled className="disabled" />
            </div>
            <div className="settings-field">
              <label>Phone</label>
              <input type="tel" placeholder="+1 555 000 0000" value={profile.phone} onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} maxLength={20} />
            </div>
            <div className="settings-field">
              <label>Bio / About</label>
              <textarea
                placeholder="Hey there! I'm using ChatApp."
                value={profile.bio}
                onChange={(e) => setProfile((p) => ({ ...p, bio: e.target.value }))}
                maxLength={500}
                rows={3}
              />
              <span className="settings-hint">{profile.bio?.length || 0}/500</span>
            </div>

            {profileMsg && <p className="settings-success">{profileMsg}</p>}
            {profileError && <p className="settings-error">{profileError}</p>}
            <button className="settings-save-btn" type="submit" disabled={profileLoading}>
              {profileLoading ? 'Saving…' : 'Save Profile'}
            </button>
          </form>
        )}

        {activeTab === 'account' && (
          <form className="settings-form" onSubmit={changePassword}>
            <h3 className="settings-section-title">Change Password</h3>
            <div className="settings-field">
              <label>Current Password</label>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
            </div>
            <div className="settings-field">
              <label>New Password</label>
              <input type="password" placeholder="Min. 6 characters" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </div>
            <div className="settings-field">
              <label>Confirm New Password</label>
              <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </div>
            {pwdMsg && <p className="settings-success">{pwdMsg}</p>}
            {pwdError && <p className="settings-error">{pwdError}</p>}
            <button className="settings-save-btn" type="submit" disabled={pwdLoading}>
              {pwdLoading ? 'Updating…' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

export default Settings
