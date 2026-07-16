import { useState } from 'react'
import axios from 'axios'
import { Link, useNavigate } from 'react-router-dom'

const Register = () => {
  const [user, setUser] = useState({
    name: '',
    email: '',
    password: ''
  })
  const [error, setError] = useState('')
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      await axios.post('/api/auth/register', user)
      navigate('/login')
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to create account. Please try again.')
    }
  }

  const handleChange = (e) => {
    const { name, value } = e.target
    setUser((prevUser) => ({
      ...prevUser,
      [name]: value
    }))
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Create Account</h1>
        <p className="auth-subtitle">Join the chat and start connecting</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <input type="text" name="name" placeholder="Enter Name" value={user.name} onChange={handleChange} />
          <input type="email" name="email" placeholder="Enter Email" value={user.email} onChange={handleChange} />
          <input type="password" name="password" placeholder="Enter Password" value={user.password} onChange={handleChange} />

          <button className="auth-button" type="submit">Register</button>

          {error && <p className="auth-message">{error}</p>}
          <p className="auth-link">Already have an account? <Link to="/login">Login here</Link></p>
        </form>
      </div>
    </div>
  )
}

export default Register
