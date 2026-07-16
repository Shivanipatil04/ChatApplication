import React from 'react'
import {useState} from 'react'
import axios from 'axios'
import {Link} from 'react-router-dom'
import Register from './pages/Register'

const Login = () => {
    const[email, setEmail] = useState("");
    const[password, setPassword] = useState("");
    const[msg, setMsg] = useState("");

    const handleLogin = async (e) =>{
        e.preventDefault();
        try{
            const res = await axios.post("http://localhost:5000/api/login",{email, password})
            setMsg(res.data.msg);
        }
        catch(err){
            setMsg(err.response.data.msg);
        }
    }

    const handleChange = (e) =>{
        const{name, value} = e.target;
    }

  return (
    <div className="login">
        <h1>Login</h1>
        <form onSubmit ={handleLogin}>
            <input type = "email" placeholder = "Enter Email" value = {email} onChange = {(e) => setEmail(e.target.value)}/>

            <input type = "password" placeholder = "Enter Password" value = {password} onChange = {(e) => setPassword(e.target.value)}/>

            <button type="submit">Login</button>
            <p>Don't have an account? <Link to = "/register">Register Here</Link></p>
        </form>
    </div>
  )
}

export default Login
