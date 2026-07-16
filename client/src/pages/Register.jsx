import React, { useState } from 'react'
import axios from 'axios'
import { Link, useNavigate } from 'react-router-dom'

const Register = () => {
  const [user, setUser] = useState({
    name: '',
    email: '',
    password: ''
  })
  const [msg, setMsg] = useState('')
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const res = await axios.post('http://localhost:5000/api/register', user)
      localStorage.setItem('isLoggedIn', 'true')
      setMsg(res.data.msg)
      navigate('/chat')
    } catch (err) {
      setMsg(err.response?.data?.msg || 'Registration failed')
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
          {msg && <p className="auth-message">{msg}</p>}
          <p className="auth-link">Already have an account? <Link to="/login">Login Here</Link></p>
        </form>
      </div>
    </div>
  )
}

export default Register
