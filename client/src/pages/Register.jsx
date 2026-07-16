import React from 'react'
import {useState} from 'react'
import axios from 'axios'
import {Link} from 'react-router-dom'

const Register = () => {

    const[user, setUser] = useState({
        name: "",
        email: "",
        password:""
    });

    const handleSubmit = async (e) =>{
        e.preventDefault();
        try{
            const res = await axios.post("http://localthost:5000/api/register",user);
            console.log(res.data);
        }
        catch(err){
            console.log(err)
        }

    }

    const handleChange = (e) =>{
        const{name, value} = e.target;
        setUser((prevUser)=>({
            ...prevUser,
            [name]: value
        })
    )}

  return (
    <div className="register">
        <h1>Register Yourself</h1>
        <form onSubmit={handleSubmit}>
            <input type="text" placeholder="Enter Name" value={user.name} onChange={(e)=> setName(e.target.value)}/>

            <input type="email" placeholder="Enter Email" value={user.email} onChange={(e)=> setEmail(e.target.value)}/>

            <input type="password" placeholder="Enter Password" value={user.password} onChange={(e)=> setPassword(e.target.value)}/>

            <button type="submit">Register</button>

            <p>Already have an account? <Link to="/login">Login Here</Link></p>
        </form>
    </div>
  )
}

export default Register