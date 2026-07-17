import React from 'react'
import { Link, useNavigate } from 'react-router-dom'

const Navbar = () => {
  const navigate = useNavigate()
  const isLoggedIn = Boolean(localStorage.getItem('chatToken'))

  const handleLogout = () => {
    localStorage.removeItem('chatToken')
    localStorage.removeItem('chatUser')
    navigate('/login')
  }

  return (
    <nav className="navbar">
      <Link className="nav-brand" to="/">ChatApp</Link>

      <div className="nav-links">
        <Link className="nav-link" to="/">Home</Link>
        {isLoggedIn ? (
          <>
            <Link className="nav-link" to="/chat">Chat</Link>
            <button className="nav-button" onClick={handleLogout}>Logout</button>
          </>
        ) : (
          <>
            <Link className="nav-link" to="/login">Login</Link>
            <Link className="nav-button" to="/register">Sign Up</Link>
          </>
        )}
      </div>
    </nav>
  )
}

export default Navbar