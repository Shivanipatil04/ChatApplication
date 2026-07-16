import React, { useState } from 'react'
import axios from 'axios'
import { Link } from 'react-router-dom'

const Register = () => {
  const [user, setUser] = useState({
    name: '',
    email: '',
    password: ''
  })
  const [msg, setMsg] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    try {
      const res = await axios.post('http://localhost:5000/api/register', user)
      setMsg(res.data.msg)
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
    <div className="register">
      <h1>Register Yourself</h1>
      <form onSubmit={handleSubmit}>
        <input type="text" name="name" placeholder="Enter Name" value={user.name} onChange={handleChange} />
        <input type="email" name="email" placeholder="Enter Email" value={user.email} onChange={handleChange} />
        <input type="password" name="password" placeholder="Enter Password" value={user.password} onChange={handleChange} />

        <button type="submit">Register</button>
        {msg && <p>{msg}</p>}
        <p>Already have an account? <Link to="/login">Login Here</Link></p>
      </form>
    </div>
  )
}

export default Register
