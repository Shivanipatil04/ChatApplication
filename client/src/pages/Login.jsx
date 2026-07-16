import React from 'react'
import {useState} from 'react'
import axios from 'axios'
import {Link} from 'react-router-dom'
import Register from './pages/Register'

const Login = () => {
  return (
    <div className="login">
        <h1>Login</h1>
        <form onSubmit ={handleLogin}>
            <input type = "email" placeholder = "Enter Email" value = {email} onChange = {(e) => setEmail(e.target.value)}/>

            <input type = "password" placeholder = "Enter Password" value = {password} onChange = {(e) => setPassword(e.target.value)}/>

            <button type="submit">Login</button>
            <p>Don't have an account? <Link to = "/Register">Register Here</Link></p>
        </form>
    </div>
  )
}

export default Login
