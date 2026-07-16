import React from 'react'
import { Link } from 'react-router-dom'

const Home = () => {
  return (
    <div className="home-page">
      <div className="hero-card">
        <p className="hero-badge">Realtime chat app</p>
        <h1>Talk with friends instantly</h1>
        <p className="hero-text">
          Join the conversation, sign up, and start chatting with your people in real time.
        </p>
        <div className="hero-actions">
          <Link className="hero-button primary" to="/register">Sign Up</Link>
          <Link className="hero-button secondary" to="/login">Login</Link>
        </div>
      </div>
    </div>
  )
}

export default Home
